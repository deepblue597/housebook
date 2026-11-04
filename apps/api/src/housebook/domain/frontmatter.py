"""Split a Markdown note into frontmatter and body, reading every value as a string.

PyYAML's default loaders follow YAML 1.1 (`serial: 0123` -> 83, `model: no` -> False).
`yaml.BaseLoader` keeps every scalar a string; types are applied later by `item.parse_fields`.
"""

import re
from dataclasses import dataclass
from typing import Any

import yaml

_OPEN_RE = re.compile(r"^---[ \t]*$")
_CLOSE_RE = re.compile(r"^(---|\.\.\.)[ \t]*$")

# Limits for hostile or broken files (anything a sync tool or a stranger's vault can deliver).
MAX_NOTE_BYTES = 4 * 1024 * 1024
MAX_FRONTMATTER_CHARS = 64 * 1024
MAX_DEPTH = 32
MAX_NODES = 10_000


class FrontmatterError(ValueError):
    pass


class _StringLoader(yaml.BaseLoader):
    """BaseLoader (every scalar a string) that refuses aliases and bounds depth and size.

    Aliases (`*name`) are how "billion laughs" files expand a few hundred bytes into megabytes;
    Obsidian never writes them. Composition is recursive, so depth is capped before Python's
    recursion limit could be reached."""

    def __init__(self, stream: str) -> None:
        super().__init__(stream)
        self._depth = 0
        self._nodes = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.AliasEvent):
            raise FrontmatterError("YAML aliases (*name) are not supported")
        self._nodes += 1
        if self._nodes > MAX_NODES:
            raise FrontmatterError(f"frontmatter has more than {MAX_NODES} values")
        self._depth += 1
        try:
            if self._depth > MAX_DEPTH:
                raise FrontmatterError(f"frontmatter is nested deeper than {MAX_DEPTH} levels")
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1


@dataclass(frozen=True)
class ParsedNote:
    has_frontmatter: bool
    data: dict[str, Any]  # values are str, list or dict of str (never int/bool/date)
    body: str


def decode(raw: bytes) -> str:
    """UTF-8 (BOM tolerated), line endings normalised to LF."""
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise FrontmatterError(f"not valid UTF-8 ({e.reason} at byte {e.start})") from None
    return text.replace("\r\n", "\n").replace("\r", "\n")


def split(text: str) -> tuple[str | None, str]:
    """Return (frontmatter_text, body). Frontmatter must start on the first line.

    An opening `---` without a closing line is treated as a half-written file and raises.
    """
    lines = text.split("\n")
    if not lines or not _OPEN_RE.match(lines[0]):
        return None, text
    for i in range(1, len(lines)):
        if _CLOSE_RE.match(lines[i]):
            body = "\n".join(lines[i + 1 :])
            return "\n".join(lines[1:i]), body
    raise FrontmatterError("frontmatter is not closed (missing '---' line)")


def parse(raw: bytes) -> ParsedNote:
    if len(raw) > MAX_NOTE_BYTES:
        raise FrontmatterError(f"file is larger than {MAX_NOTE_BYTES // (1024 * 1024)} MiB")
    text = decode(raw)
    fm_text, body = split(text)
    if fm_text is None:
        return ParsedNote(False, {}, body)
    if len(fm_text) > MAX_FRONTMATTER_CHARS:
        raise FrontmatterError(f"frontmatter is larger than {MAX_FRONTMATTER_CHARS // 1024} KiB")
    try:
        data = yaml.load(fm_text, Loader=_StringLoader)  # noqa: S506 - BaseLoader subclass, strings only
    except RecursionError:  # belt and braces; MAX_DEPTH should stop it first
        raise FrontmatterError("frontmatter is nested too deeply") from None
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (line {mark.line + 2})" if mark else ""
        problem = getattr(e, "problem", None) or str(e)
        raise FrontmatterError(f"invalid YAML{where}: {problem}") from None
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise FrontmatterError("frontmatter is not a key/value mapping")
    return ParsedNote(True, data, body)


# --- tags -----------------------------------------------------------------------------

HOUSEBOOK_TAG = "housebook"


def tags_of(data: dict[str, Any]) -> list[str]:
    """Tags in every form Obsidian writes: `tags`/`tag`, string or list, comma or space
    separated, with or without `#`."""
    out: list[str] = []
    for key in ("tags", "tag"):
        out.extend(_flatten_tags(data.get(key)))
    return out


def _flatten_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [t for v in value for t in _flatten_tags(v)]
    if isinstance(value, str):
        return [t.lstrip("#") for t in re.split(r"[,\s]+", value) if t.lstrip("#")]
    return []


def is_housebook_tagged(data: dict[str, Any]) -> bool:
    """`housebook` or a nested tag below it (`housebook/kitchen`), case-insensitive."""
    for tag in tags_of(data):
        t = tag.casefold()
        if t == HOUSEBOOK_TAG or t.startswith(HOUSEBOOK_TAG + "/"):
            return True
    return False
