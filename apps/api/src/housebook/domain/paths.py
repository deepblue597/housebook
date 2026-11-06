"""File-name rules: which files to ignore, which are sync conflict copies, safe names."""

import re
import unicodedata
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


# --- names for new files (DESIGN 15.3) ---------------------------------------------------------

# Characters Windows (and so Syncthing/OneDrive peers) can't store, on top of separators and
# control characters.
_WINDOWS_CHARS = re.compile(r'[<>:"|?*]')
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
MAX_NAME_BYTES = 120  # UTF-8 bytes of the stem; leaves room for "-NN.md" and sync-tool suffixes


def clean_filename(name: str, fallback: str = "Item", max_bytes: int = MAX_NAME_BYTES) -> str:
    """A file-name stem (no extension) that is safe on every OS and sync tool: NFC, no path
    separators or control characters, no characters Windows rejects, no leading dot (hidden,
    ignored by the scanner), no trailing dots/spaces, at most `max_bytes` UTF-8 bytes."""
    s = unicodedata.normalize("NFC", name)
    s = _UNSAFE_CHARS.sub(" ", s)
    s = _WINDOWS_CHARS.sub(" ", s)
    s = re.sub(r"\s+", " ", s).lstrip(". ").strip()
    if is_conflict_copy(s):  # a new note must never look like a sync conflict copy
        s = re.sub(r"sync-conflict", "sync conflict", s, flags=re.IGNORECASE).replace("(", " ").replace(")", " ")
        s = re.sub(r"\s+", " ", s).strip()
    encoded = s.encode("utf-8")[:max_bytes]
    s = encoded.decode("utf-8", errors="ignore").rstrip(". ").strip()
    bad = not s or s.split(".")[0].upper() in _WINDOWS_RESERVED or is_conflict_copy(s + ".md")
    if bad or is_ignored_name(s) or is_ignored_name(s + ".md"):
        return fallback
    return s


def unique_stem(stem: str, taken: set[str]) -> str:
    """`stem`, else `stem-2`, `stem-3`, ... `taken` holds casefolded NFC names already used in
    the folder (both `X.md` notes and `X` attachment folders count, so a new note never
    inherits someone else's attachments)."""
    candidate, n = stem, 1
    while candidate.casefold() in taken or f"{candidate}.md".casefold() in taken:
        n += 1
        candidate = f"{stem}-{n}"
    return candidate
