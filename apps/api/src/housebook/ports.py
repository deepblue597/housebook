"""Ports (DESIGN 8.2). Cheap Protocols with one adapter each (15.17); they mark where a
different storage or index (SQLite/FTS5, D9) would slot in."""

from dataclasses import dataclass
from datetime import datetime
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

    def write(self, data: bytes) -> None:
        """Atomic replace. Only PUT /api/house (and migrations) call this (D8)."""
        ...

    def save_history(self, previous: bytes, now: datetime, migrated_from: int | None = None) -> str:
        """Keep a copy of the previous layout; returns its file name."""
        ...


class NoteRepo(Protocol):
    def walk(self) -> Tree:
        """All non-ignored files under the data root (notes and attachments)."""
        ...

    def read(self, rel: str) -> bytes: ...

    def is_note(self, rel: str) -> bool:
        """True for `*.md` files inside the notes folder."""
        ...

    def write(self, rel: str, data: bytes) -> None:
        """Atomic replace of an existing note."""
        ...

    def create(self, rel: str, data: bytes) -> None:
        """Write a new note (FileExistsError if the path is taken)."""
        ...

    def names_in(self, folder_rel: str) -> set[str]:
        """Casefolded NFC entry names of a folder, for collision checks."""
        ...

    def existing_name(self, folder_rel: str, name: str) -> str | None:
        """On-disk spelling of `name` in a folder (NFC- and case-insensitive match), if present."""
        ...

    def trash(self, rel: str, label: str, now: datetime) -> str:
        """Move a note (and its attachment folder) to the trash; returns the trash folder."""
        ...


class AttachmentStore(Protocol):
    def open_path(self, rel: str) -> Path:
        """Resolved absolute path of a regular file inside the data root, else UnsafePath."""
        ...

    # milestone 6: save(note_rel, name, stream), trash(rel)


class SearchIndex(Protocol):
    def search(self, query: str) -> list[str]:
        """Item ids, best match first."""
        ...
