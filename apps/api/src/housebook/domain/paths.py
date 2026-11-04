"""File-name rules: which files to ignore, which are sync conflict copies, safe names."""

import re
from fnmatch import fnmatchcase

# Dot-files and dot-dirs are always ignored (.housebook, .obsidian, .trash, .stversions, ...).
IGNORED_NAME_PATTERNS = (
    "*.tmp",
    "*.swp",
    "*~",
    "4913",  # vim's write test file
    "~syncthing~*",
    "*.crdownload",
    "*.part",
)

_CONFLICT_RES = (
    # Syncthing: Note.sync-conflict-20260101-120000-ABCDEFG.md
    re.compile(r"\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}", re.IGNORECASE),
    # Nextcloud, Dropbox, Obsidian Sync: "Note (conflicted copy 2026-01-01 ...).md"
    re.compile(r"\(conflicted copy\b", re.IGNORECASE),
    re.compile(r"\(conflict(ed)? \d{4}-\d{2}-\d{2}", re.IGNORECASE),
)

_UNSAFE_CHARS = re.compile(r"[\x00-\x1f\x7f/\\]")


def is_ignored_name(name: str) -> bool:
    if name.startswith("."):
        return True
    return any(fnmatchcase(name, p) for p in IGNORED_NAME_PATTERNS)


def is_conflict_copy(name: str) -> bool:
    return any(r.search(name) for r in _CONFLICT_RES)


def is_safe_name(name: str) -> bool:
    """A single path component a client may ask for: no NUL/control chars, no separators,
    no leading dot (covers `.` and `..`), not empty, not absurdly long."""
    return bool(name) and len(name) <= 255 and not name.startswith(".") and not _UNSAFE_CHARS.search(name)
