"""Ports (DESIGN 8.2). Cheap Protocols with one adapter each (15.17); they mark where
writes (milestone 4) and a different index (SQLite/FTS5, D9) would slot in."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class FileEntry:
    rel: str  # POSIX path relative to the data root, as on disk (may be NFD)
    size: int
    mtime_ns: int
    readable: bool = True  # False when the server process lacks read permission


@dataclass(frozen=True)
class Tree:
    """One walk of the data root."""

    files: tuple[FileEntry, ...]
    outside_links: tuple[str, ...]  # symlinks (files or dirs) that resolve outside the root
    unreadable_dirs: tuple[str, ...] = ()  # folders that couldn't be listed (permissions, I/O)


class UnsafePath(Exception):
    """A path that resolves outside the data root, is not a regular file, or is malformed."""


class HouseRepo(Protocol):
    def read(self) -> bytes | None:
        """Raw house.json, or None if it doesn't exist."""
        ...

    # milestone 4: write(data: bytes, if_match: str | None) -> str


class NoteRepo(Protocol):
    def walk(self) -> Tree:
        """All non-ignored files under the data root (notes and attachments)."""
        ...

    def read(self, rel: str) -> bytes: ...

    def is_note(self, rel: str) -> bool:
        """True for `*.md` files inside the notes folder."""
        ...

    # milestone 4: write(rel, data, if_match), trash(rel)


class AttachmentStore(Protocol):
    def open_path(self, rel: str) -> Path:
        """Resolved absolute path of a regular file inside the data root, else UnsafePath."""
        ...

    # milestone 6: save(note_rel, name, stream), trash(rel)


class SearchIndex(Protocol):
    def search(self, query: str) -> list[str]:
        """Item ids, best match first."""
        ...
