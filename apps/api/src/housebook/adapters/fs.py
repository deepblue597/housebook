"""Filesystem adapters over the data root."""

import logging
import os
import re
import secrets
import shutil
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath

from housebook.domain.paths import is_ignored_name
from housebook.domain.text import nfc
from housebook.ports import FileEntry, Tree, UnsafePath

log = logging.getLogger(__name__)

HOUSE_FILE = "house.json"
STATE_DIR = ".housebook"
HISTORY_KEEP = 50
TRASH_DAYS = 90


def atomic_write(path: Path, data: bytes) -> None:
    """Write via a dot-prefixed temp file in the same directory, fsync, rename (DESIGN 6.6).

    Same directory: a rename across filesystems is not atomic (EXDEV on Docker volumes).
    Dot prefix: the scanner and the watcher ignore it, so a half-written file is never read.
    An existing file's permission bits are kept (Obsidian on the host must still be able to
    write it)."""
    tmp = path.parent / f".{path.name}.{secrets.token_hex(4)}.tmp"
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except FileNotFoundError:
        mode = None
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    _fsync_dir(path.parent)


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:  # not supported on every filesystem
        pass
    finally:
        os.close(fd)


def _stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime("%Y%m%dT%H%M%S") + f"{now.microsecond // 1000:03d}Z"


def resolve_inside(root: Path, rel: str) -> Path:
    """Resolve `rel` under `root`, following symlinks, and insist the result stays inside.

    `Path.resolve()` follows symlinks, so a link inside the vault that points elsewhere is
    caught here (DESIGN 15.13)."""
    if "\x00" in rel or PurePosixPath(rel).is_absolute():
        raise UnsafePath(rel)
    root_r = root.resolve()
    try:
        resolved = (root_r / rel).resolve(strict=True)
    except (OSError, RuntimeError) as e:  # missing file, symlink loop
        raise UnsafePath(rel) from e
    if not resolved.is_relative_to(root_r):
        raise UnsafePath(rel)
    return resolved


_HISTORY_RE = re.compile(r"^house-(\d{8}T\d{9}Z)(?:-(\d+))?\.json$")


def _history_key(name: str) -> tuple[str, int] | None:
    """Order of rotating history files: timestamp, then the -2, -3 suffix of same-millisecond
    saves. Other files in the folder (pre-migration originals, the user's own) are never rotated."""
    m = _HISTORY_RE.match(name)
    return (m[1], int(m[2] or 1)) if m else None


class FsHouseRepo:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.history_dir = root / STATE_DIR / "history"

    def read(self) -> bytes | None:
        path = self.root / HOUSE_FILE
        if not path.exists() and not path.is_symlink():
            return None
        return resolve_inside(self.root, HOUSE_FILE).read_bytes()  # UnsafePath if it escapes

    def write(self, data: bytes) -> None:
        path = self.root / HOUSE_FILE
        if path.exists() or path.is_symlink():
            path = resolve_inside(self.root, HOUSE_FILE)  # write through an in-root symlink
        atomic_write(path, data)

    def save_history(self, previous: bytes, now: datetime, migrated_from: int | None = None) -> str:
        """Copy the previous house.json to .housebook/history/ (DESIGN 15.2, 15.4) and keep the
        last 50 `house-*.json`. The pre-migration original (`house.v<n>.*.json`) is never rotated."""
        self.history_dir.mkdir(parents=True, exist_ok=True)
        stamp = _stamp(now)
        if migrated_from is not None:
            name = f"house.v{migrated_from}.{stamp}.json"
        else:
            # Same-millisecond saves get -2, -3, ...: always above any suffix already used, so a
            # rotated-out name is never reused for the newest copy.
            used = [k[1] for p in self.history_dir.iterdir() if (k := _history_key(p.name)) and k[0] == stamp]
            name = f"house-{stamp}.json" if not used else f"house-{stamp}-{max(used) + 1}.json"
        atomic_write(self.history_dir / name, previous)
        ours = [(key, p) for p in self.history_dir.iterdir() if (key := _history_key(p.name)) and p.is_file()]
        for _, old in sorted(ours)[:-HISTORY_KEEP]:
            old.unlink(missing_ok=True)
        return name


class MarkdownNoteRepo:
    def __init__(self, root: Path, notes_dir: str) -> None:
        self.root = root
        self.notes_prefix = PurePosixPath(notes_dir).as_posix().strip("/") + "/"

    def is_note(self, rel: str) -> bool:
        """`*.md` inside the notes folder, no part of the path ignored by the scanner."""
        return (
            rel.startswith(self.notes_prefix)
            and rel.lower().endswith(".md")
            and not any(is_ignored_name(part) for part in rel.split("/"))
        )

    def _in_notes(self, folder_rel: str) -> bool:
        """A folder inside the notes folder, no part of the path ignored by the scanner."""
        return f"{folder_rel}/".startswith(self.notes_prefix) and not any(
            is_ignored_name(part) for part in folder_rel.split("/")
        )

    def walk(self) -> Tree:
        root_r = self.root.resolve()
        files: list[FileEntry] = []
        outside: list[str] = []
        unreadable: list[str] = []

        def on_error(err: OSError) -> None:
            if err.filename:
                rel = Path(err.filename).relative_to(root_r).as_posix()
                unreadable.append("" if rel == "." else rel)

        for dirpath, dirnames, filenames in os.walk(root_r, onerror=on_error, followlinks=False):
            base = Path(dirpath)
            kept = []
            for d in dirnames:
                if is_ignored_name(d):
                    continue
                full = base / d
                if full.is_symlink():  # never descended into; reported if it escapes
                    if not _inside(full, root_r):
                        outside.append(full.relative_to(root_r).as_posix())
                    continue
                kept.append(d)
            dirnames[:] = sorted(kept)
            for name in sorted(filenames):
                if is_ignored_name(name):
                    continue
                full = base / name
                rel = full.relative_to(root_r).as_posix()
                if full.is_symlink() and not _inside(full, root_r):
                    outside.append(rel)
                    continue
                try:
                    st = full.stat()
                except OSError:  # dangling symlink or vanished mid-walk
                    continue
                if not os.path.isfile(full):
                    continue
                files.append(
                    FileEntry(rel=rel, size=st.st_size, mtime_ns=st.st_mtime_ns, readable=os.access(full, os.R_OK))
                )
        return Tree(files=tuple(files), outside_links=tuple(outside), unreadable_dirs=tuple(unreadable))

    def read(self, rel: str) -> bytes:
        return resolve_inside(self.root, rel).read_bytes()

    def write(self, rel: str, data: bytes) -> None:
        """Replace an existing note (through an in-root symlink, never replacing the link)."""
        atomic_write(resolve_inside(self.root, rel), data)

    def names_in(self, folder_rel: str) -> set[str]:
        """Casefolded NFC names in a folder (empty if it doesn't exist), for collision checks."""
        try:
            folder = resolve_inside(self.root, folder_rel)
        except UnsafePath:
            return set()
        try:
            return {nfc(n).casefold() for n in os.listdir(folder)}
        except OSError:
            return set()

    def existing_name(self, folder_rel: str, name: str) -> str | None:
        """The on-disk spelling of `name` in a folder, compared in NFC and case-insensitively."""
        try:
            entries = os.listdir(resolve_inside(self.root, folder_rel))
        except (UnsafePath, OSError):
            return None
        key = nfc(name).casefold()
        return next((e for e in sorted(entries) if nfc(e).casefold() == key), None)

    def create(self, rel: str, data: bytes) -> None:
        """Write a new note; its folder is created (inside the notes folder only)."""
        if not self.is_note(rel) or "\x00" in rel or ".." in PurePosixPath(rel).parts:
            raise UnsafePath(rel)
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.parent.resolve().is_relative_to(self.root.resolve()):
            raise UnsafePath(rel)
        if path.exists() or path.is_symlink():
            raise FileExistsError(rel)
        atomic_write(path, data)

    def trash(self, rel: str, label: str, now: datetime) -> str:
        """Move a note, and its sibling attachment folder unless that holds other notes, to
        .housebook/trash/<stamp>-<label>/ (DESIGN 8.3, 15.14). Returns the trash folder."""
        note = resolve_inside(self.root, rel)
        dest = self.root / STATE_DIR / "trash" / f"{_stamp(now)}-{re.sub(r'[^A-Za-z0-9_-]', '_', label)}"
        dest.mkdir(parents=True, exist_ok=False)
        sibling = self.root / rel[:-3] if rel.lower().endswith(".md") else None
        shutil.move(note, dest / note.name)
        if sibling and sibling.is_dir() and not sibling.is_symlink():
            has_notes = any(p.suffix.lower() == ".md" for p in sibling.rglob("*"))
            if not has_notes:
                shutil.move(sibling, dest / sibling.name)
        return dest.relative_to(self.root).as_posix()

    def upload_dir(self) -> Path:
        folder = self.root / STATE_DIR / "uploads"
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def add_file(self, folder_rel: str, name: str, src: Path) -> None:
        rel = f"{folder_rel}/{name}"
        parts = PurePosixPath(rel).parts
        if "\x00" in rel or ".." in parts or is_ignored_name(name) or not self._in_notes(folder_rel):
            raise UnsafePath(rel)
        folder = self.root / folder_rel
        folder.mkdir(parents=True, exist_ok=True)
        if not folder.resolve().is_relative_to(self.root.resolve()):
            raise UnsafePath(rel)
        dest = folder / name
        if dest.exists() or dest.is_symlink():
            raise FileExistsError(rel)
        try:
            os.link(src, dest)  # fails instead of replacing a file that appeared meanwhile
            src.unlink()
        except OSError as e:
            if isinstance(e, FileExistsError):
                raise
            shutil.move(src, dest)  # another filesystem (EXDEV) or no hard links (some shares)
        _fsync_dir(folder)

    def trash_file(self, rel: str, label: str, now: datetime) -> str:
        path = resolve_inside(self.root, rel)
        dest = self.root / STATE_DIR / "trash" / f"{_stamp(now)}-{re.sub(r'[^A-Za-z0-9_-]', '_', label)}"
        dest.mkdir(parents=True, exist_ok=False)
        shutil.move(path, dest / path.name)
        return dest.relative_to(self.root).as_posix()

    def purge_trash(self, now: datetime, days: int = TRASH_DAYS) -> int:
        """Delete trash folders older than `days` (by the stamp in their name). Startup only."""
        trash = self.root / STATE_DIR / "trash"
        if not trash.is_dir():
            return 0
        cutoff = now - timedelta(days=days)
        purged = 0
        for entry in trash.iterdir():
            try:
                when = datetime.strptime(entry.name[:15], "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
            except ValueError:
                continue  # not ours; leave it
            if when >= cutoff:
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
            purged += 1
        return purged


class FsAttachmentStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def open_path(self, rel: str) -> Path:
        path = resolve_inside(self.root, rel)
        if not path.is_file():
            raise UnsafePath(rel)
        return path


def _inside(path: Path, root_r: Path) -> bool:
    try:
        return path.resolve(strict=False).is_relative_to(root_r)
    except (OSError, RuntimeError):
        return False
