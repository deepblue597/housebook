"""Write operations (milestone 4). Blocking; always called through `Sync.write`, which holds the
single write lock, rescans afterwards and announces the change.

Single writer per file (D8): `house.json` is written only by `put_house`; notes only by the item
operations here. No operation touches both, so no cross-file transaction is needed.

Preconditions are checked against the file **on disk**, not the index: if Obsidian saved the
note a moment ago and the watcher hasn't caught up, the client's ETag is still rejected.
"""

import contextlib
import logging
import posixpath
import secrets
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from housebook.config import Settings
from housebook.domain.attachments import link_target
from housebook.domain.catalog import Catalog
from housebook.domain.frontmatter import MAX_NOTE_BYTES, FrontmatterError, is_housebook_tagged, parse
from housebook.domain.house import CURRENT_SCHEMA_VERSION, House, HouseIssue, house_issues, serialize, worse_issues
from housebook.domain.item import parse_fields
from housebook.domain.note_edit import (
    Edited,
    NoteEditError,
    NoteTooLarge,
    append_log,
    build_note,
    edit_note,
    insert_first_key,
    to_raw,
)
from housebook.domain.paths import clean_filename, unique_stem
from housebook.domain.problems import ProblemKind
from housebook.domain.text import nfc
from housebook.migrations.house import MigrationError, migrate
from housebook.ports import HouseRepo, NoteRepo, UnsafePath
from housebook.services.indexer import IndexedItem, Indexer, IndexState, content_hash

log = logging.getLogger(__name__)

ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
DEFAULT_BODY = "\n## Quick help\n\n## Maintenance log\n\n## Notes\n"  # templates arrive in milestone 6
RESERVED_CREATE_KEYS = ("housebook_id", "type", "name")


# --- errors (mapped to HTTP responses in api/app.py) -------------------------------------------------


@dataclass
class WriteError(Exception):
    status: int
    detail: Any
    extra: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    refresh_index: bool = False  # the index may be behind the disk: rescan before answering

    def __str__(self) -> str:
        return str(self.detail)


def not_found(what: str = "No item with this id") -> WriteError:
    return WriteError(404, what, refresh_index=True)


def precondition_required() -> WriteError:
    return WriteError(428, "If-Match is required (send the ETag you last read)")


def precondition_failed(current: str | None) -> WriteError:
    headers = {"ETag": f'"{current}"'} if current else {}
    return WriteError(
        412,
        "The file changed since you read it; reload it and apply your change again",
        extra={"currentEtag": current},
        headers=headers,
        refresh_index=True,
    )


def conflict(message: str, reason: str) -> WriteError:
    return WriteError(409, message, extra={"reason": reason})


def too_large(e: Exception) -> WriteError:
    return WriteError(413, str(e))


def unprocessable(errors: list[dict[str, Any]]) -> WriteError:
    """Same shape as FastAPI's request validation errors: `{"detail": [{type, loc, msg}]}`."""
    return WriteError(422, errors)


def field_error(loc: list[str | int], msg: str, type_: str = "value_error") -> dict[str, Any]:
    return {"type": type_, "loc": ["body", *loc], "msg": msg}


def _etags(header: str) -> set[str]:
    """Entity tags of an If-Match / If-None-Match header. Weak and strong compare equal here:
    our ETags are content hashes, and the snapshot hands them out unquoted."""
    return {t.strip().removeprefix("W/").strip('"') for t in header.split(",") if t.strip()}


def check_preconditions(if_match: str | None, if_none_match: str | None, current: str | None) -> None:
    """RFC 9110 order for PUT /api/house: If-Match first, then If-None-Match (`*` fails if the
    file exists; a list fails if it holds the current ETag). At least one is required."""
    has_inm = if_none_match is not None and bool(if_none_match.strip())
    if if_match is not None and if_match.strip():
        check_if_match(if_match, current)
    elif not has_inm:
        raise precondition_required()
    if has_inm:
        assert if_none_match is not None
        tags = _etags(if_none_match)
        if ("*" in tags and current is not None) or (current is not None and current in tags):
            raise precondition_failed(current)


def check_if_match(if_match: str | None, current: str | None) -> None:
    if if_match is None or not if_match.strip():
        raise precondition_required()
    tags = _etags(if_match)
    if "*" in tags:
        if current is None:
            raise precondition_failed(None)
        return
    if current is None or current not in tags:
        raise precondition_failed(current)


# --- the operations -------------------------------------------------------------------------------


class Writer:
    def __init__(
        self,
        house_repo: HouseRepo,
        notes: NoteRepo,
        indexer: Indexer,
        catalog: Catalog,
        settings: Settings,
        clock: Callable[[], datetime],
    ) -> None:
        self.house_repo = house_repo
        self.notes = notes
        self.indexer = indexer
        self.catalog = catalog
        self.settings = settings
        self.clock = clock

    # house.json -------------------------------------------------------------------------------

    def put_house(self, house: House, if_match: str | None, if_none_match: str | None) -> tuple[str, House]:
        """Replace the layout. `If-Match: <etag>` (or `*`) for an existing file; `If-None-Match: *`
        to create a missing one. Returns the new ETag and the layout as written.

        `house` has passed the structural check only (`parse_house`). Order: 409 `unreadable` (the
        preconditions can't be judged without the file), 428/412, 409 read-only, then the semantic
        check, under the write lock, against the file on disk (D30): issues that file already has
        may stay; new ones (and any `house_bad_cell`) are a 422."""
        try:
            raw = self.house_repo.read()
        except (UnsafePath, OSError) as e:
            raise conflict(f"house.json can't be read ({e.__class__.__name__}); it is read-only", "unreadable") from e
        current = content_hash(raw) if raw is not None else None
        check_preconditions(if_match, if_none_match, current)

        state = self._state()
        if state.house.etag != current:
            state = self.indexer.scan()  # the index is behind the disk; judge the file on disk
        hs = state.house
        if hs.read_only:
            reason = next(
                (
                    str((p.detail or {}).get("reason", "invalid"))
                    for p in state.problems
                    if p.kind in (ProblemKind.house_newer_version, ProblemKind.house_invalid)
                ),
                "invalid",
            )
            raise conflict(
                "house.json is read-only (see /api/problems): it is newer than this image or can't be read as "
                "a valid layout, so it is never overwritten",
                reason,
            )
        if hs.etag != current:
            # Replaced between our read and the rescan: the baseline (and the read-only verdict)
            # would come from a file the client never matched. (A read-only state may carry the
            # last good version's ETag, so this is checked after the 409, which never writes.)
            raise precondition_failed(hs.etag)
        baseline = house_issues(hs.house) if raw is not None and hs.house is not None else []
        worse = worse_issues(house_issues(house), baseline)
        if worse:
            raise unprocessable(issue_errors(worse))
        if house.schema_ is None and hs.house is not None and hs.house.schema_:
            house = house.model_copy(update={"schema_": hs.house.schema_})  # keep the editor hint
        data = serialize(house)
        if raw is not None and data == raw:
            return current or content_hash(data), house
        if raw is not None:
            name = self.house_repo.save_history(
                raw, self.clock(), migrated_from=hs.schema_version if hs.migrated else None
            )
            log.debug("house history saved", extra={"file": name})
        self.house_repo.write(data)
        etag = content_hash(data)
        log.info("house.json written", extra={"etag": etag, "previous": current})
        return etag, house

    # notes ------------------------------------------------------------------------------------

    def patch_item(
        self, item_id: str, if_match: str | None, frontmatter: dict[str, Any] | None, body: str | None
    ) -> None:
        item, raw = self._current(item_id)
        check_if_match(if_match, content_hash(raw))
        if frontmatter and "housebook_id" in frontmatter and frontmatter["housebook_id"] != item_id:
            raise unprocessable(
                [field_error(["frontmatter", "housebook_id"], "housebook_id can't be changed", "read_only")]
            )
        edited = self._edit(raw, frontmatter, body)
        self._check_fields(edited.data, set(frontmatter or ()))
        self._write(item, raw, edited.raw, "patch")

    def append_log(self, item_id: str, day: date, text: str) -> None:
        """No If-Match: an append merges with whatever is on disk now (DESIGN 15.6, D11)."""
        item, raw = self._current(item_id)
        try:
            body = parse(raw).body
        except FrontmatterError as e:
            raise self._unparseable(e) from e
        edited = self._edit(raw, None, append_log(body, day, text))
        self._write(item, raw, edited.raw, "log")

    def delete_item(self, item_id: str, if_match: str | None) -> str:
        item, raw = self._current(item_id)
        check_if_match(if_match, content_hash(raw))
        dest = self.notes.trash(item.rel, item_id, self.clock())
        log.info("note moved to trash", extra={"item_id": item_id, "path": item.rel, "trash": dest})
        return dest

    # attachments (D33) ---------------------------------------------------------------------------

    def add_attachment(self, item_id: str, src: Path, original_name: str, extension: str) -> str:
        """Move a prepared upload into the item's attachments folder (`House/K/Dishwasher/`, next
        to the note) and list it in `attachments` as a wikilink, which Obsidian keeps current
        when files move. No If-Match: like a log entry, adding merges with whatever is on disk.
        Returns the stored file name (made unique in the folder)."""
        item, raw = self._current(item_id)
        try:
            data = parse(raw).data
        except FrontmatterError as e:
            raise self._unparseable(e) from e
        folder = _attachments_folder(item.rel)
        stem = clean_filename(posixpath.splitext(original_name)[0], fallback="Attachment")
        taken = self.notes.names_in(folder)
        name, n = f"{stem}{extension}", 1
        while name.casefold() in taken:
            n += 1
            name = f"{stem}-{n}{extension}"
        link = f"[[{posixpath.basename(folder)}/{name}]]"
        # Edit first (it can still fail: size, an unwritable note), then move the file in.
        edited = self._edit(raw, {"attachments": [*_attachment_links(data.get("attachments")), link]}, None)
        try:
            self.notes.add_file(folder, name, src)
        except FileExistsError as e:
            raise conflict("a file with this name appeared meanwhile; try again", "exists") from e
        except UnsafePath as e:
            raise conflict("the item's attachments folder can't be written", "unsafe") from e
        self._write(item, raw, edited.raw, "attach")
        log.info("attachment added", extra={"item_id": item_id, "path": f"{folder}/{name}"})
        return name

    def delete_attachment(self, item_id: str, name: str) -> str:
        """Move an attachment to `.housebook/trash/` and remove its link from `attachments`.
        Only files in the item's own attachments folder: a link to a file elsewhere may be shared
        with other notes (409 `not_in_folder`; remove the link in the note instead)."""
        item, raw = self._current(item_id)
        att = next((a for a in item.attachments if a.name == nfc(name)), None)
        if att is None:
            raise not_found("No such attachment")
        if nfc(posixpath.dirname(att.rel)) != nfc(_attachments_folder(item.rel)):
            raise conflict(
                "the file is outside the item's attachments folder (maybe shared); remove its link in the note",
                "not_in_folder",
            )
        edited: Edited | None = None
        if att.listed:
            try:
                data = parse(raw).data
            except FrontmatterError as e:
                raise self._unparseable(e) from e
            links = _attachment_links(data.get("attachments"))
            keep = [link for link in links if not _points_to(link, item.rel, att.rel)]
            if len(keep) != len(links):
                edited = self._edit(raw, {"attachments": keep or None}, None)
        dest = self.notes.trash_file(att.rel, f"{item_id}-attachment", self.clock())
        if edited is not None:
            self._write(item, raw, edited.raw, "detach")
        log.info("attachment moved to trash", extra={"item_id": item_id, "path": att.rel, "trash": dest})
        return dest

    def create_item(
        self,
        type_key: str,
        name: str | None,
        room_id: str | None,
        frontmatter: dict[str, Any],
        body: str | None,
    ) -> str:
        """New note at `<notes>/<Room>/<Name>.md` (DESIGN 8.4). The client adds the placement with
        PUT /api/house afterwards (D8), so the layout is never touched here."""
        errors: list[dict[str, Any]] = []
        item_type = self.catalog.resolve(type_key)
        if item_type is None:
            errors.append(field_error(["type"], f"unknown item type '{type_key}'"))
        for key in RESERVED_CREATE_KEYS:
            if key in frontmatter:
                errors.append(field_error(["frontmatter", key], f"'{key}' is set by the server or the top-level field"))
        display = (name or (item_type.default_name if item_type else "")).strip()
        if not display and item_type is not None:
            errors.append(field_error(["name"], "name must not be empty"))
        if any(unicodedata.category(ch) == "Cc" for ch in display):
            errors.append(field_error(["name"], "name must not contain control characters (tabs, newlines, NUL)"))
        state = self._state()
        folder = self.settings.notes_dir
        if room_id is not None:
            house = state.house.house
            room = next((r for r in house.rooms if r.id == room_id), None) if house else None
            if room is None:
                errors.append(field_error(["roomId"], f"no room with id '{room_id}'"))
            else:
                # Reuse a folder that is already there in another normalisation (NFD from macOS)
                # or case, instead of creating a visually identical twin.
                wanted = clean_filename(room.name, fallback="Room")
                folder = f"{folder}/{self.notes.existing_name(folder, wanted) or wanted}"
        if errors:
            raise unprocessable(errors)
        assert item_type is not None

        item_id = self._new_id(state)
        extra = {k: v for k, v in frontmatter.items() if v is not None}
        tags = extra.pop("tags", ["housebook"])
        data = {"housebook_id": item_id, "type": item_type.key, "name": display, **extra, "tags": tags}
        try:
            raw = build_note(data, DEFAULT_BODY if body is None else body)
        except NoteTooLarge as e:
            raise too_large(e) from e
        except NoteEditError as e:
            raise unprocessable([field_error(["frontmatter"], str(e))]) from e
        self._check_fields(to_raw(data), set(frontmatter))
        self._check_size(raw)
        stem = unique_stem(clean_filename(display), self.notes.names_in(folder))
        rel = f"{folder}/{stem}.md"
        try:
            self.notes.create(rel, raw)
        except FileExistsError as e:
            raise conflict("a file with this name appeared meanwhile; try again", "exists") from e
        log.info("note created", extra={"item_id": item_id, "path": rel})
        return item_id

    def adopt(self, rel: str) -> str:
        """Write a new `housebook_id` into a tagged note without one (`not_adopted`, contract §3.3).
        Only notes inside the notes folder; the id goes on the first frontmatter line."""
        wanted = nfc(posixpath.normpath(rel.replace("\\", "/")).lstrip("/"))
        state = self._state()
        # Only notes the last scan reported as `not_adopted`: never a file the scanner ignores
        # (hidden folders, temp files) or one outside the notes folder.
        adoptable = {p.path for p in state.problems if p.kind == ProblemKind.not_adopted and p.path}
        if wanted not in adoptable:
            if not self.notes.is_note(wanted) or wanted.startswith("../"):
                raise unprocessable([field_error(["path"], "not a note inside the notes folder")])
            raise not_found("No adoptable note at this path (see `not_adopted` in /api/problems)")
        # Problems report NFC paths; find the file as it is spelled on disk.
        rel = next((f.rel for f in self.notes.walk().files if nfc(f.rel) == wanted), wanted)
        try:
            raw = self.notes.read(rel)
        except (UnsafePath, FileNotFoundError) as e:
            raise not_found("No such note") from e
        try:
            parsed = parse(raw)
        except FrontmatterError as e:
            raise self._unparseable(e) from e
        if not parsed.has_frontmatter or not is_housebook_tagged(parsed.data):
            raise conflict("the note has no housebook tag; add `tags: [housebook]` first", "not_tagged")
        if str(parsed.data.get("housebook_id") or "").strip():
            raise conflict("the note already has a housebook_id", "has_id")
        item_id = self._new_id(state)
        try:
            data = insert_first_key(raw, "housebook_id", item_id)
        except NoteEditError as e:
            raise conflict(f"the note can't be edited safely: {e}", "unparseable") from e
        self.notes.write(rel, data)
        log.info("note adopted", extra={"item_id": item_id, "path": rel})
        return item_id

    # helpers ---------------------------------------------------------------------------------

    def _state(self) -> IndexState:
        return self.indexer.state or self.indexer.scan()

    def _current(self, item_id: str) -> tuple[IndexedItem, bytes]:
        item = self._state().items.get(item_id)
        if item is None:
            raise not_found()
        try:
            return item, self.notes.read(item.rel)
        except (UnsafePath, FileNotFoundError) as e:
            raise not_found() from e

    @staticmethod
    def _unparseable(e: Exception) -> WriteError:
        return conflict(f"the note can't be parsed ({e}); fix it in an editor first", "unparseable")

    def _edit(self, raw: bytes, frontmatter: dict[str, Any] | None, body: str | None) -> Edited:
        try:
            edited = edit_note(raw, frontmatter, body)
        except FrontmatterError as e:
            raise self._unparseable(e) from e
        except NoteTooLarge as e:
            raise too_large(e) from e
        except NoteEditError as e:
            raise unprocessable([field_error(["frontmatter"], str(e))]) from e
        self._check_size(edited.raw)
        return edited

    @staticmethod
    def _check_size(raw: bytes) -> None:
        if len(raw) > MAX_NOTE_BYTES:
            raise WriteError(413, f"note would be larger than {MAX_NOTE_BYTES // (1024 * 1024)} MiB")

    @staticmethod
    def _check_fields(data: dict[str, Any], touched: set[str]) -> None:
        """Known keys the request set must parse (a bad value on disk drops only that field, but
        the app never writes one)."""
        _, errors = parse_fields(data)
        bad = [e for e in errors if e.key in touched]
        if bad:
            raise unprocessable([field_error(["frontmatter", e.key], e.message) for e in bad])

    def _write(self, item: IndexedItem, before: bytes, after: bytes, op: str) -> None:
        if parse(after).data.get("housebook_id") != item.id:
            raise conflict("the file no longer belongs to this item", "id_changed")
        if after == before:
            return
        self.notes.write(item.rel, after)
        log.info("note written", extra={"op": op, "item_id": item.id, "path": item.rel, "etag": content_hash(after)})

    @staticmethod
    def _new_id(state: IndexState) -> str:
        while True:
            item_id = "it_" + "".join(secrets.choice(ID_ALPHABET) for _ in range(6))
            if item_id not in state.items:
                return item_id


def parse_house(data: Any) -> House:
    """Structural check for PUT (types, ranges, patterns, unknown keys), each error with its JSON
    location. Semantic rules are judged later by `Writer.put_house` against the file on disk (D30).

    An older `schemaVersion` is upgraded first, as on read (D41): a browser still running the
    previous app sends version 1 after an upgrade, and its layout is still good."""
    version = data.get("schemaVersion") if isinstance(data, dict) else None
    if isinstance(version, int) and not isinstance(version, bool) and 1 <= version < CURRENT_SCHEMA_VERSION:
        # On failure the model reports schemaVersion, with its location.
        with contextlib.suppress(MigrationError):
            data = migrate(data).data
    try:
        return House.model_validate(data, context={"tolerant": True})
    except ValidationError as e:
        raise unprocessable(
            [{"type": x["type"], "loc": ["body", *x["loc"]], "msg": x["msg"]} for x in e.errors()]
        ) from e


def issue_errors(issues: list[HouseIssue]) -> list[dict[str, Any]]:
    """Semantic issues in the `{type, loc, msg}` shape of a 422 (`type` = the problem kind)."""
    return [{"type": i.code, "loc": ["body", *i.loc], "msg": i.message} for i in issues]


def _attachments_folder(note_rel: str) -> str:
    """`House/Kitchen/Dishwasher.md` -> `House/Kitchen/Dishwasher` (contract §3.4)."""
    return note_rel[:-3] if note_rel.lower().endswith(".md") else note_rel


def _attachment_links(value: Any) -> list[str]:
    """The `attachments` frontmatter as a list of link strings. An unquoted
    `attachments: [[x.pdf]]` reads as a nested list; it is written back as `"[[x.pdf]]"`."""
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for v in value:
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list) and len(v) == 1 and isinstance(v[0], list) and len(v[0]) == 1:
            out.append(f"[[{v[0][0]}]]")  # [[x]] inside a flow list
        elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
            out.append(f"[[{', '.join(v)}]]")
    return out


def _points_to(link: str, note_rel: str, target_rel: str) -> bool:
    """Whether a link names `target_rel`: relative to the note's folder or the data root, or by
    a bare file name (the same order links resolve in, contract §3.4)."""
    t = nfc(link_target(link)).replace("\\", "/")
    want = nfc(target_rel)
    if not t:
        return False
    if posixpath.normpath(posixpath.join(posixpath.dirname(nfc(note_rel)), t)) == want:
        return True
    if posixpath.normpath(t) == want:
        return True
    return "/" not in t and t == posixpath.basename(want)
