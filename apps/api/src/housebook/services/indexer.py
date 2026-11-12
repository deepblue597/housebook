"""Full scan of the data root -> immutable in-memory index (D9).

Each scan builds a fresh `IndexState` and swaps it in; readers keep whatever state they
grabbed. The previous state feeds two rules from DESIGN 15.2:
- duplicate ids: the canonical file is the path already in the index;
- parse failures keep the last good entry (flagged stale) instead of dropping the item.
Milestone 4's watcher will call the same code for single paths; the periodic rescan stays
the correctness path.
"""

import hashlib
import json
import logging
import posixpath
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime
from typing import Any

from pydantic import ValidationError

from housebook.domain.attachments import FileIndex, LinkError, resolve_link, sibling_files
from housebook.domain.catalog import Catalog, ItemType
from housebook.domain.finishes import Finishes
from housebook.domain.frontmatter import FrontmatterError, is_housebook_tagged, parse
from housebook.domain.house import CURRENT_SCHEMA_VERSION, House, HouseIssue, house_issues, normalise_cells, room_at
from housebook.domain.item import ItemFields, error_codes, last_log_date, parse_fields
from housebook.domain.paths import is_conflict_copy
from housebook.domain.problems import HouseProblemReason as Why
from housebook.domain.problems import Problem, ProblemKind, Severity
from housebook.domain.search import SearchDoc
from housebook.domain.text import nfc
from housebook.domain.textures import MANIFEST_REL, TEXTURES_DIR, ManifestError, OwnTexture, parse_manifest
from housebook.migrations.house import MigrationError, migrate
from housebook.ports import FileEntry, HouseRepo, NoteRepo, TextureRepo, UnsafePath

log = logging.getLogger(__name__)

MAX_HOUSE_BYTES = 16 * 1024 * 1024


def content_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:32]


@dataclass(frozen=True)
class Attachment:
    name: str  # NFC file name, unique within the item; used in the download URL
    rel: str  # actual path relative to the data root
    size: int
    listed: bool  # listed in frontmatter (vs. only found in the sibling folder)
    mtime_ns: int = 0


@dataclass(frozen=True)
class Location:
    floor_id: str
    room_id: str | None
    x: int
    y: int
    rotation: int


@dataclass(frozen=True)
class IndexedItem:
    id: str
    rel: str
    hash: str
    mtime_ns: int
    raw: dict[str, Any]  # frontmatter, all values strings; unknown keys preserved
    fields: ItemFields
    body: str
    error_codes: tuple[str, ...]
    last_service: date | None
    item_type: ItemType | None
    conflict_copy: bool
    attachments: tuple[Attachment, ...] = ()
    location: Location | None = None
    stale: bool = False  # current file failed to parse; this is the last good version
    parse_error: str | None = None


@dataclass(frozen=True)
class HouseState:
    house: House | None
    etag: str | None
    schema_version: int | None
    read_only: bool = False  # file is newer than this image (D13)
    migrated: bool = False
    stale: bool = False  # current file is invalid; this is the last good version
    cell_issues: tuple[HouseIssue, ...] = ()  # cell keys rewritten or dropped while loading


@dataclass(frozen=True)
class IndexedTexture:
    """An uploaded texture (D43) and a version of its file (size and mtime), None if missing."""

    texture: OwnTexture
    file_version: str | None


@dataclass(frozen=True)
class IndexState:
    house: HouseState
    items: dict[str, IndexedItem]
    problems: tuple[Problem, ...]
    search_docs: tuple[SearchDoc, ...]
    scanned_at: datetime
    scan_ms: float
    textures: tuple[IndexedTexture, ...] = ()
    # rel -> (hash, parse outcome) so unchanged files skip YAML parsing on the next scan
    _parse_cache: dict[str, tuple[str, Any]] = field(default_factory=dict, repr=False)


class Indexer:
    def __init__(
        self,
        house_repo: HouseRepo,
        notes: NoteRepo,
        catalog: Catalog,
        finishes: Finishes | None = None,
        textures: TextureRepo | None = None,
    ) -> None:
        self.house_repo = house_repo
        self.notes = notes
        self.catalog = catalog
        self.finishes = finishes  # None: finish names aren't checked
        self.textures = textures  # None: no uploaded textures
        self.state: IndexState | None = None
        self._lock = threading.Lock()

    def scan(self) -> IndexState:
        with self._lock:
            started = time.perf_counter()
            state = _Scan(self, self.state).run()
            state = replace(state, scan_ms=round((time.perf_counter() - started) * 1000, 1))
            self.state = state
            log.info(
                "scan done",
                extra={"items": len(state.items), "problems": len(state.problems), "ms": state.scan_ms},
            )
            return state


class _Scan:
    """One scan. Plain procedural code; collects problems as it goes."""

    def __init__(self, indexer: Indexer, previous: IndexState | None) -> None:
        self.ix = indexer
        self.prev = previous
        self.problems: list[Problem] = []
        self.parse_cache: dict[str, tuple[str, Any]] = {}
        self.prev_by_rel = {i.rel: i for i in previous.items.values()} if previous else {}
        self.unreadable_files: set[str] = set()
        self.mtimes: dict[str, int] = {}
        self.textures: tuple[IndexedTexture, ...] = ()

    def problem(self, kind: ProblemKind, severity: Severity, message: str, **kw: Any) -> None:
        if kw.get("path"):
            kw["path"] = nfc(kw["path"])  # reported in NFC, like attachment names (macOS writes NFD)
        self.problems.append(Problem(kind=kind, severity=severity, message=message, **kw))

    def run(self) -> IndexState:
        tree = self.ix.notes.walk()
        files = FileIndex.build([f.rel for f in tree.files], tree.outside_links)
        for rel in tree.outside_links:
            self.problem(
                ProblemKind.symlink_outside_root,
                Severity.warning,
                "Symlink points outside the data root and is ignored",
                path=rel,
            )

        self.textures = self.scan_textures(tree.files)
        house = self.scan_house()
        notes = [f for f in tree.files if self.ix.notes.is_note(f.rel)]
        candidates = [c for f in notes if (c := self.scan_note(f.rel, f.mtime_ns))]
        candidates += self.unreadable_dirs(tree.unreadable_dirs, {f.rel for f in notes})
        items = self.pick_canonical(candidates)
        sizes = {f.rel: f.size for f in tree.files}
        self.mtimes = {f.rel: f.mtime_ns for f in tree.files}
        self.unreadable_files = {f.rel for f in tree.files if not f.readable}
        items = {i: self.finish_item(item, house.house, files, sizes) for i, item in items.items()}

        if house.house:
            for p in house.house.placements:
                if p.item_id not in items:
                    self.problem(
                        ProblemKind.missing_note,
                        Severity.warning,
                        f"Placement on floor '{p.floor_id}' at {p.x},{p.y} has no note with this id",
                        item_id=p.item_id,
                    )

        sev_order = {Severity.error: 0, Severity.warning: 1, Severity.info: 2}
        problems = sorted(self.problems, key=lambda p: (sev_order[p.severity], p.path or "", p.kind))
        return IndexState(
            house=house,
            items=dict(sorted(items.items())),
            problems=tuple(problems),
            search_docs=tuple(self.search_doc(i, house.house) for i in items.values()),
            scanned_at=datetime.now(UTC),
            scan_ms=0.0,
            textures=self.textures,
            _parse_cache=self.parse_cache,
        )

    # --- house.json -------------------------------------------------------------------

    def scan_house(self) -> HouseState:
        """house.json is writable only when it parsed and validated as the current schemaVersion.
        Anything else (newer, non-integer or missing version, unreadable or invalid file) is
        read-only, so a future PUT can never overwrite a file this image doesn't understand.
        A missing file is not read-only: there is nothing to protect (first run creates it)."""
        prev = self.prev.house if self.prev else None
        try:
            raw = self.ix.house_repo.read()
        except (UnsafePath, OSError) as e:
            return self._house_failed(prev, Why.unreadable, f"house.json can't be read: {e.__class__.__name__}")
        if raw is None:
            self.problem(ProblemKind.house_missing, Severity.error, "house.json does not exist", path="house.json")
            return HouseState(None, None, None)
        etag = content_hash(raw)
        # Unchanged, valid, writable file: reuse it. Read-only states (newer schemaVersion) are
        # re-evaluated, since their problem comes from the evaluation, not from _house_issues.
        if prev and prev.etag == etag and not prev.stale and not prev.read_only and prev.house:
            self._house_issues(prev)
            return prev
        if len(raw) > MAX_HOUSE_BYTES:  # refused before parsing: too large to read
            limit = f"file is larger than {MAX_HOUSE_BYTES // (1024 * 1024)} MiB"
            return self._house_failed(prev, Why.too_large, f"house.json is invalid: {limit}", etag)
        try:
            data = json.loads(raw.decode("utf-8-sig"))
        except RecursionError:
            return self._house_failed(prev, Why.not_json, "house.json is invalid: nested too deeply", etag)
        except ValueError as e:  # UnicodeDecodeError and JSONDecodeError are ValueErrors
            return self._house_failed(prev, Why.not_json, f"house.json is invalid: {_short_error(e)}", etag)

        version = data.get("schemaVersion") if isinstance(data, dict) else None
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            shown = "missing" if not isinstance(data, dict) or "schemaVersion" not in data else json.dumps(version)
            message = f"house.json is invalid: schemaVersion must be an integer >= 1 (got {shown})"
            return self._house_failed(prev, Why.bad_version, message, etag)
        if version > CURRENT_SCHEMA_VERSION:
            return self._newer_house(prev, data, etag, version)

        data, cell_issues = normalise_cells(data)
        try:
            m = migrate(data)
            house = House.model_validate(m.data, context={"tolerant": True})
        except RecursionError:
            return self._house_failed(prev, Why.invalid, "house.json is invalid: nested too deeply", etag, version)
        except MigrationError as e:  # an older schemaVersion this image has no migration for
            return self._house_failed(prev, Why.bad_version, f"house.json is invalid: {_short_error(e)}", etag, version)
        except ValidationError as e:
            return self._house_failed(prev, Why.invalid, f"house.json is invalid: {_short_error(e)}", etag, version)
        state = HouseState(house, etag, m.original_version, migrated=m.migrated, cell_issues=tuple(cell_issues))
        self._house_issues(state)
        return state

    def _newer_house(self, prev: HouseState | None, data: dict, etag: str, version: int) -> HouseState:
        """Written by a newer image (after a rollback): always read-only, decided before any
        validation, so a layout this image can't parse is still never overwritten (D13)."""
        self.problem(
            ProblemKind.house_newer_version,
            Severity.warning,
            f"house.json has schemaVersion {version}, newer than this image supports ({CURRENT_SCHEMA_VERSION}); "
            "the layout is read-only until the image is upgraded",
            path="house.json",
            detail={"reason": Why.newer_version},
        )
        data, cell_issues = normalise_cells(data)
        try:
            # Show what we understand: unknown keys dropped.
            house = House.model_validate({**data, "schemaVersion": CURRENT_SCHEMA_VERSION}, context={"lenient": True})
        except (ValidationError, RecursionError) as e:
            kept = prev.house if prev else None
            self.problem(
                ProblemKind.house_invalid,
                Severity.error,
                f"house.json (schemaVersion {version}) can't be displayed by this image: {_short_error(e)}"
                + ("; showing the last valid version" if kept else ""),
                path="house.json",
                # The cause is the newer version (upgrade the image), not a file to fix.
                detail={"reason": Why.newer_version},
            )
            return HouseState(kept, etag, version, read_only=True, stale=kept is not None)
        state = HouseState(house, etag, version, read_only=True, cell_issues=tuple(cell_issues))
        self._house_issues(state)
        return state

    def _house_failed(
        self, prev: HouseState | None, why: Why, message: str, etag: str | None = None, version: int | None = None
    ) -> HouseState:
        kept = prev is not None and prev.house is not None
        self.problem(
            ProblemKind.house_invalid,
            Severity.error,
            message + ("; showing the last valid version" if kept else "") + "; read-only until fixed",
            path="house.json",
            detail={"reason": why},
        )
        if kept:
            assert prev is not None
            return replace(prev, stale=True, read_only=True)
        return HouseState(None, etag, version, read_only=True)

    def _house_issues(self, state: HouseState) -> None:
        if not state.house:
            return
        for issue in (*state.cell_issues, *house_issues(state.house)):
            kind = ProblemKind(issue.code)
            self.problem(kind, Severity.warning, issue.message, path="house.json")
        finishes = self.ix.finishes
        if finishes is None:
            return
        floor_keys = finishes.floor_keys | {t.texture.key for t in self.textures if t.texture.kind == "floor"}
        wallpaper_keys = finishes.wallpaper_keys | {
            t.texture.key for t in self.textures if t.texture.kind == "wallpaper"
        }
        # Unknown finish names (a typo, a newer catalogue, a deleted texture): drawn in the plan colour (D41).
        for room in state.house.rooms:
            if room.floor and room.floor not in floor_keys:
                self.problem(
                    ProblemKind.house_unknown_finish,
                    Severity.warning,
                    f"room '{room.id}': unknown floor finish '{room.floor}'; shown in the plan colour",
                    path="house.json",
                )
            if room.walls and not room.walls.startswith("#") and room.walls not in wallpaper_keys:
                self.problem(
                    ProblemKind.house_unknown_finish,
                    Severity.warning,
                    f"room '{room.id}': unknown wallpaper '{room.walls}'; shown in the plain wall colour",
                    path="house.json",
                )

    # --- Textures/textures.json (D43) ---------------------------------------------------

    def scan_textures(self, files: tuple[FileEntry, ...]) -> tuple[IndexedTexture, ...]:
        """The uploaded textures. A manifest that can't be used is an error, and the last valid
        list is kept (as for house.json), so rooms don't lose their finish while a sync tool is
        halfway through writing it. A listed file that is gone is a warning: drawn in its colour."""
        repo = self.ix.textures
        if repo is None:
            return ()
        try:
            raw = repo.read_manifest()
            manifest = parse_manifest(raw) if raw is not None else None
        except (UnsafePath, OSError, ManifestError) as e:
            why = str(e) if isinstance(e, ManifestError) else f"{MANIFEST_REL} can't be read"
            kept = self.prev.textures if self.prev else ()
            self.problem(
                ProblemKind.textures_invalid,
                Severity.error,
                why + ("; showing the last valid list" if kept else "") + "; textures can't be added until fixed",
                path=MANIFEST_REL,
            )
            return kept
        if manifest is None:
            return ()
        on_disk = {nfc(f.rel): f for f in files if f.readable}
        out = []
        for t in manifest.textures:
            entry = on_disk.get(nfc(f"{TEXTURES_DIR}/{t.file}"))
            if entry is None:
                self.problem(
                    ProblemKind.texture_missing,
                    Severity.warning,
                    f"texture '{t.label}' ({t.key}): {TEXTURES_DIR}/{t.file} is missing; shown in its colour",
                    path=MANIFEST_REL,
                )
            version = f"{entry.size:x}-{entry.mtime_ns:x}" if entry else None
            out.append(IndexedTexture(t, version))
        return tuple(out)

    # --- notes --------------------------------------------------------------------------

    def _keep_last_good(
        self, rel: str, error: str, kind: ProblemKind = ProblemKind.note_parse_error
    ) -> IndexedItem | None:
        prev = self.prev_by_rel.get(rel)
        self.problem(
            kind,
            Severity.error,
            error + ("; showing the last valid version" if prev else ""),
            path=rel,
            item_id=prev.id if prev else None,
        )
        if prev:
            return replace(prev, stale=True, parse_error=error)
        return None

    def unreadable_dirs(self, dirs: tuple[str, ...], seen: set[str]) -> list[IndexedItem]:
        """A folder that can't be listed hides its notes; keep their last good versions."""
        kept: list[IndexedItem] = []
        for d in dirs:
            self.problem(
                ProblemKind.read_error,
                Severity.error,
                "Folder can't be read (check permissions); notes inside keep their last good version",
                path=d or ".",
            )
            prefix = f"{d}/" if d else ""
            for rel, prev in self.prev_by_rel.items():
                if rel.startswith(prefix) and rel not in seen:
                    kept.append(replace(prev, stale=True, parse_error=f"folder '{d}' can't be read"))
        return kept

    def scan_note(self, rel: str, mtime_ns: int) -> IndexedItem | None:
        try:
            raw = self.ix.notes.read(rel)
        except UnsafePath:
            return None  # swapped for an escaping symlink since the walk; next scan reports it
        except OSError as e:
            return self._keep_last_good(rel, f"file can't be read ({e.strerror or e})", ProblemKind.read_error)
        if not raw.strip():
            # 0-byte files are usually mid-write; only an issue if the note was known before.
            return self._keep_last_good(rel, "file is empty") if rel in self.prev_by_rel else None

        digest = content_hash(raw)
        cached = self.prev._parse_cache.get(rel) if self.prev else None
        if cached and cached[0] == digest:
            parsed = cached[1]
        else:
            try:
                parsed = parse(raw)
            except FrontmatterError as e:
                parsed = e
        self.parse_cache[rel] = (digest, parsed)
        if isinstance(parsed, FrontmatterError):
            return self._keep_last_good(rel, str(parsed))
        if not parsed.has_frontmatter:
            return None

        fields, errors = parse_fields(parsed.data)
        for err in errors:
            if err.key == "housebook_id":
                self.problem(
                    ProblemKind.note_invalid_id, Severity.error, f"housebook_id '{err.value}': {err.message}", path=rel
                )
            else:
                self.problem(
                    ProblemKind.note_invalid_field,
                    Severity.warning,
                    f"{err.key}: '{err.value}' ignored ({err.message})",
                    path=rel,
                    item_id=fields.housebook_id,
                    detail={"key": err.key},
                )

        if fields.housebook_id is None:
            if any(e.key == "housebook_id" for e in errors):
                return None
            if is_housebook_tagged(parsed.data):
                self.problem(
                    ProblemKind.not_adopted,
                    Severity.info,
                    "Tagged note without housebook_id; it gets an id when it is first opened or placed",
                    path=rel,
                )
            elif self.ix.catalog.resolve(fields.type):
                self.problem(
                    ProblemKind.untagged_typed,
                    Severity.info,
                    f"Note has type '{fields.type}' but no housebook tag or id; add `tags: [housebook]` to use it",
                    path=rel,
                )
            return None

        body = parsed.body
        item = IndexedItem(
            id=fields.housebook_id,
            rel=rel,
            hash=digest,
            mtime_ns=mtime_ns,
            raw=parsed.data,
            fields=fields,
            body=body,
            error_codes=tuple(error_codes(body)),
            last_service=last_log_date(body),
            item_type=self.ix.catalog.resolve(fields.type),
            conflict_copy=is_conflict_copy(posixpath.basename(rel)),
        )
        return item

    def pick_canonical(self, candidates: list[IndexedItem]) -> dict[str, IndexedItem]:
        by_id: dict[str, list[IndexedItem]] = {}
        for c in candidates:
            by_id.setdefault(c.id, []).append(c)
        out: dict[str, IndexedItem] = {}
        for item_id, group in by_id.items():
            prev = self.prev.items.get(item_id) if self.prev else None
            prev_rel = prev.rel if prev else None
            # Canonical: path already indexed, then not a conflict copy, then oldest mtime.
            group.sort(key=lambda i: (i.rel != prev_rel, i.conflict_copy, i.mtime_ns, i.rel))
            canonical, *others = group
            out[item_id] = canonical
            for o in others:
                kind = ProblemKind.conflict_copy if o.conflict_copy else ProblemKind.duplicate_id
                what = "Sync conflict copy" if o.conflict_copy else "Duplicate"
                self.problem(
                    kind,
                    Severity.warning,
                    f"{what} of '{canonical.rel}' (same housebook_id); assign a new id or move it to the trash",
                    path=o.rel,
                    item_id=item_id,
                    detail={"canonical": canonical.rel},
                )
            if canonical.conflict_copy:
                self.problem(
                    ProblemKind.conflict_copy,
                    Severity.warning,
                    "Item exists only as a sync conflict copy; rename the file",
                    path=canonical.rel,
                    item_id=item_id,
                )
        return out

    def finish_item(
        self,
        item: IndexedItem,
        house: House | None,
        files: FileIndex,
        sizes: dict[str, int],
    ) -> IndexedItem:
        if item.fields.type and item.item_type is None:
            self.problem(
                ProblemKind.unknown_type,
                Severity.warning,
                f"Unknown type '{item.fields.type}'; shown as a generic item",
                path=item.rel,
                item_id=item.id,
            )
        return replace(
            item,
            attachments=self.attachments_of(item, files, sizes),
            location=_location(house, item.id),
        )

    def attachments_of(self, item: IndexedItem, files: FileIndex, sizes: dict[str, int]) -> tuple[Attachment, ...]:
        found: list[tuple[str, bool]] = []
        for link in item.fields.attachments:
            try:
                found.append((resolve_link(files, item.rel, link), True))
            except LinkError as e:
                self.problem(
                    ProblemKind.attachment_unsafe if e.unsafe else ProblemKind.attachment_missing,
                    Severity.warning,
                    f"Attachment {link}: {e}",
                    path=item.rel,
                    item_id=item.id,
                )
        found += [(rel, False) for rel in sibling_files(files, item.rel)]

        out: dict[str, Attachment] = {}
        seen: set[str] = set()
        for rel, listed in found:
            if rel in seen:
                continue
            seen.add(rel)
            if rel in self.unreadable_files:
                self.problem(
                    ProblemKind.read_error,
                    Severity.error,
                    "Attachment can't be read (check permissions); it is not served",
                    path=rel,
                    item_id=item.id,
                )
                continue
            name = nfc(posixpath.basename(rel))
            if name in out:
                self.problem(
                    ProblemKind.attachment_name_collision,
                    Severity.warning,
                    f"Two attachments are named '{name}'; only '{out[name].rel}' is served",
                    path=item.rel,
                    item_id=item.id,
                )
                continue
            out[name] = Attachment(
                name=name, rel=rel, size=sizes.get(rel, 0), listed=listed, mtime_ns=self.mtimes.get(rel, 0)
            )
        return tuple(out.values())

    def search_doc(self, item: IndexedItem, house: House | None) -> SearchDoc:
        f = item.fields
        room_name = ""
        if house and item.location and item.location.room_id:
            room_name = next((r.name for r in house.rooms if r.id == item.location.room_id), "")
        return SearchDoc(
            id=item.id,
            name=display_name(item),
            error_codes=item.error_codes,
            model=f.model or "",
            brand=f.brand or "",
            serial=f.serial or "",
            type_label=item.item_type.label if item.item_type else "",
            room=room_name,
            body=item.body,
        )


def attachments_etag(item: IndexedItem) -> str:
    """Changes whenever the attachment set changes (a file added, removed, replaced or resized),
    which the note's own etag doesn't reflect. Short hash of sorted name/size/mtime."""
    parts = sorted(f"{a.name}\0{a.size}\0{a.mtime_ns}" for a in item.attachments)
    return content_hash("\n".join(parts).encode())[:16]


def display_name(item: IndexedItem) -> str:
    """`name`, else the file name without `.md`."""
    if item.fields.name:
        return item.fields.name
    base = nfc(posixpath.basename(item.rel))
    return base[:-3] if base.lower().endswith(".md") else base


def _location(house: House | None, item_id: str) -> Location | None:
    if not house:
        return None
    for p in house.placements:
        if p.item_id == item_id:
            return Location(p.floor_id, room_at(house, p.floor_id, p.x, p.y), p.x, p.y, p.rotation)
    return None


def _short_error(e: Exception) -> str:
    if isinstance(e, ValidationError):
        errs = e.errors()
        first = errs[0]
        loc = ".".join(str(x) for x in first["loc"])
        more = f" (+{len(errs) - 1} more)" if len(errs) > 1 else ""
        return f"{loc}: {first['msg']}{more}"
    return str(e)
