"""Filesystem adapters over the data root."""

import os
from pathlib import Path, PurePosixPath

from housebook.domain.paths import is_ignored_name
from housebook.ports import FileEntry, Tree, UnsafePath

HOUSE_FILE = "house.json"


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


class FsHouseRepo:
    def __init__(self, root: Path) -> None:
        self.root = root

    def read(self) -> bytes | None:
        path = self.root / HOUSE_FILE
        if not path.exists() and not path.is_symlink():
            return None
        return resolve_inside(self.root, HOUSE_FILE).read_bytes()  # UnsafePath if it escapes


class MarkdownNoteRepo:
    def __init__(self, root: Path, notes_dir: str) -> None:
        self.root = root
        self.notes_prefix = PurePosixPath(notes_dir).as_posix().strip("/") + "/"

    def is_note(self, rel: str) -> bool:
        return rel.startswith(self.notes_prefix) and rel.lower().endswith(".md")

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
