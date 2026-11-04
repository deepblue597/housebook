"""Text normalisation shared by search, filenames and attachment matching."""

import re
import unicodedata

_COMPACT_RE = re.compile(r"[\s\-_./]+")


def nfc(value: str) -> str:
    """Normalise to NFC. macOS/iOS hand us NFD, which breaks equality for Greek accents."""
    return unicodedata.normalize("NFC", value)


def fold(value: str) -> str:
    """Case- and accent-insensitive form: NFD, drop combining marks, lower-case, final sigma
    `ς` -> `σ`, NFC. `ψυγείο`, `ΨΥΓΕΙΟ` and `ψυγειο` all fold to `ψυγειο`.

    Deliberately `lower()` rather than `casefold()`: JS has `toLowerCase()` but no casefold,
    and the frontend must fold identically (contract/fixtures/search_cases.json).
    """
    decomposed = unicodedata.normalize("NFD", value)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return unicodedata.normalize("NFC", stripped.lower().replace("ς", "σ"))


def compact(value: str) -> str:
    """Folded form without spaces and separators, so `FD041200123` matches `FD 0412 00123`."""
    return _COMPACT_RE.sub("", fold(value))
