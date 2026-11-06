"""Minimal-diff edits of Markdown notes (DESIGN 15.4, 15.6, D12). Pure functions over bytes/text.

Frontmatter is edited line by line: the YAML is composed (not constructed) to find where each
top-level key starts, and only the lines of keys whose value changed are replaced, deleted or
appended. Comments, key order, quoting and blank lines of untouched keys stay byte-identical,
and so do the BOM and CRLF line endings of the file. Every result is parsed again and must give
exactly the expected data and body; if line editing can't achieve that (exotic YAML such as a
flow mapping as the whole frontmatter), the frontmatter is rendered from scratch instead, and if
even that doesn't round-trip, the edit is refused (`NoteEditError`).

Strings are written plain only when every YAML reader (PyYAML's 1.1 resolver, Obsidian's 1.2)
would read them back as the same string; otherwise they are double-quoted, so `serial: "0123"`
and `model: "no"` survive other tools. Dates under the date keys and true/false under
`critical` are written plain on purpose: that is how Obsidian types those properties.
"""

import json
import re
from dataclasses import dataclass, replace
from datetime import date
from typing import Any

import yaml

from housebook.domain.frontmatter import (
    _CLOSE_RE,
    _OPEN_RE,
    MAX_FRONTMATTER_CHARS,
    MAX_NOTE_BYTES,
    FrontmatterError,
    _StringLoader,
    decode,
    parse,
)
from housebook.domain.item import _HEADING_RE

BOM = b"\xef\xbb\xbf"
DATE_KEYS = frozenset({"purchased", "warranty_until", "next_check"})
BOOL_KEYS = frozenset({"critical"})
LOG_HEADING = "Maintenance log"


class NoteEditError(ValueError):
    """The requested change can't be written safely (the note is left untouched)."""


class NoteTooLarge(NoteEditError):
    """The result would break a parsing limit (file 4 MiB, frontmatter 64 KiB)."""


# --- the file around the frontmatter ------------------------------------------------------------


@dataclass(frozen=True)
class NoteText:
    bom: bool
    crlf: bool
    open_line: str
    fm_lines: tuple[str, ...]
    close_line: str
    body: str

    def to_bytes(self) -> bytes:
        text = "\n".join((self.open_line, *self.fm_lines, self.close_line)) + "\n" + self.body
        if self.crlf:
            text = text.replace("\n", "\r\n")
        try:
            return (BOM if self.bom else b"") + text.encode("utf-8")
        except UnicodeEncodeError:
            raise NoteEditError("text contains characters that can't be stored as UTF-8") from None


def split_note(raw: bytes) -> NoteText:
    """Split a note that has frontmatter. Raises FrontmatterError otherwise."""
    crlf = raw.count(b"\r\n") * 2 > raw.count(b"\n")  # most line breaks are CRLF
    lines = decode(raw).split("\n")
    if not _OPEN_RE.match(lines[0]):
        raise FrontmatterError("note has no frontmatter")
    for i in range(1, len(lines)):
        if _CLOSE_RE.match(lines[i]):
            return NoteText(raw.startswith(BOM), crlf, lines[0], tuple(lines[1:i]), lines[i], "\n".join(lines[i + 1 :]))
    raise FrontmatterError("frontmatter is not closed (missing '---' line)")


def normalise_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


# --- values -------------------------------------------------------------------------------------


def to_raw(value: Any) -> Any:
    """The value as the string-only loader will read it back (JSON true -> "true", 5 -> "5")."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return json.dumps(value)
    if isinstance(value, list):
        return [to_raw(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_raw(v) for k, v in value.items()}
    return value


def merge_patch(target: Any, patch: Any) -> Any:
    """JSON Merge Patch (RFC 7396): `null` deletes a key, objects merge, anything else replaces."""
    if not isinstance(patch, dict):
        return patch
    out = dict(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = merge_patch(out.get(key), value)
    return out


# Plain scalars some YAML reader would turn into something other than this exact string:
# YAML 1.1 bools/nulls (yes, no, on, off, ~), ints in any base (0123 is octal 83 in 1.1),
# sexagesimal (1:30), floats incl. 1e3 / .inf / .nan, timestamps, and the merge/value keys.
_AMBIGUOUS_RE = re.compile(
    r"""(?x)^(?:
        ~ | null | Null | NULL
      | y | Y | yes | Yes | YES | n | N | no | No | NO
      | true | True | TRUE | false | False | FALSE | on | On | ON | off | Off | OFF
      | [-+]?[0-9][0-9_]*(?::[0-5]?[0-9])*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?
      | [-+]?\.[0-9_]+(?:[eE][-+]?[0-9]+)?
      | [-+]?0[xX][0-9a-fA-F_]+ | [-+]?0[oO][0-7_]+ | [-+]?0[bB][01_]+
      | [-+]?\.(?:inf|Inf|INF) | \.(?:nan|NaN|NAN)
      | [0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt\ ].*)?
      | = | <<
    )$"""
)
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_INDICATORS = frozenset("-?:,[]{}#&*!|>'\"%@`")
_FLOW_CHARS = frozenset(",[]{}")
_YAML_UNSAFE = re.compile(r"[\x7f-\x9f  ﻿]")


def _plain_ok(s: str, flow: bool) -> bool:
    if not s or s != s.strip() or s[0] in _INDICATORS:
        return False
    if ": " in s or s.endswith(":") or " #" in s:
        return False
    if flow and any(c in _FLOW_CHARS for c in s):
        return False
    if not s.isprintable():  # newlines, tabs, control and separator characters
        return False
    return not _AMBIGUOUS_RE.match(s)


def _quote(s: str) -> str:
    # A JSON string is a valid YAML double-quoted scalar, except for a few characters YAML
    # doesn't allow unescaped.
    return _YAML_UNSAFE.sub(lambda m: f"\\u{ord(m[0]):04x}", json.dumps(s, ensure_ascii=False))


def render_key(key: str, flow: bool = False) -> str:
    return key if _plain_ok(key, flow) else _quote(key)


def render_scalar(key: str, value: Any, flow: bool = False) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return json.dumps(value)
    if value is None:
        return "null"  # only reachable inside lists; the round-trip check rejects it
    s = str(value)
    if key in DATE_KEYS and _DATE_RE.match(s):
        return s
    if key in BOOL_KEYS and s in ("true", "false"):
        return s
    return s if _plain_ok(s, flow) else _quote(s)


def render_value(key: str, value: Any, flow: bool = False) -> str:
    if isinstance(value, list):
        return "[" + ", ".join(render_value(key, v, True) for v in value) + "]"
    if isinstance(value, dict):
        inner = ", ".join(f"{render_key(str(k), True)}: {render_value(str(k), v, True)}" for k, v in value.items())
        return "{" + inner + "}"
    return render_scalar(key, value, flow)


# --- line-level frontmatter editing ----------------------------------------------------------


@dataclass(frozen=True)
class _Block:
    key: str
    start: int  # first line (the key line)
    end: int  # exclusive; trailing blank lines and column-0 comments are not part of the block
    comment: str  # trailing ` # comment` of a one-line scalar entry, kept on replacement
    seq_prefix: str | None  # "  - " when the value is a block sequence
    style: str | None = None  # quote style of a scalar value (' or "), kept on replacement


class _NeedFullRender(Exception):
    pass


def _blocks(fm_lines: list[str]) -> list[_Block]:
    text = "\n".join(fm_lines)
    try:
        root = yaml.compose(text, Loader=_StringLoader)  # noqa: S506 - string-only loader
    except (yaml.YAMLError, FrontmatterError) as e:
        raise NoteEditError(f"frontmatter can't be parsed: {e}") from None
    if root is None:
        return []
    if not isinstance(root, yaml.MappingNode) or root.flow_style:
        raise _NeedFullRender
    entries = [(k.start_mark.line, k, v) for k, v in root.value]
    out: list[_Block] = []
    for idx, (line, k, v) in enumerate(entries):
        if not isinstance(k, yaml.ScalarNode):
            continue  # complex keys are never edited
        end = entries[idx + 1][0] if idx + 1 < len(entries) else len(fm_lines)
        if end <= line:
            raise _NeedFullRender  # two keys on one line
        while end > line + 1 and (not fm_lines[end - 1].strip() or fm_lines[end - 1].startswith("#")):
            end -= 1
        comment = ""
        if end == line + 1 and isinstance(v, yaml.ScalarNode) and v.end_mark.line == line:
            rest = fm_lines[line][v.end_mark.column :]
            if re.match(r"\s+#", rest):
                comment = rest
        prefix = None
        if isinstance(v, yaml.SequenceNode) and not v.flow_style and v.value:
            first = v.value[0].start_mark
            prefix = fm_lines[first.line][: first.column] if first.line < len(fm_lines) else None
            if prefix is not None and not re.fullmatch(r"\s*-\s+", prefix):
                prefix = None
        style = v.style if isinstance(v, yaml.ScalarNode) and v.style in ("'", '"') else None
        out.append(_Block(k.value, line, end, comment, prefix, style))
    return out


def render_entry(key: str, value: Any, old: _Block | None = None) -> list[str]:
    k = render_key(key)
    scalars = isinstance(value, list) and value and not any(isinstance(v, list | dict) for v in value)
    if scalars and old and old.seq_prefix:
        return [f"{k}:", *(f"{old.seq_prefix}{render_scalar(key, v)}" for v in value)]
    if value == "":
        return [f"{k}:"]
    comment = old.comment if old and not isinstance(value, list | dict) else ""
    if old and old.style and isinstance(value, str) and value.isprintable():
        # Keep the user's quoting: `serial: '0123'` stays single-quoted.
        quoted = "'" + value.replace("'", "''") + "'" if old.style == "'" else _quote(value)
        return [f"{k}: {quoted}{comment}"]
    return [f"{k}: {render_value(key, value)}{comment}"]


def edit_frontmatter(fm_lines: list[str], old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """Lines for `new`, touching only the keys whose value differs from `old`."""
    blocks = _blocks(fm_lines)
    by_key: dict[str, list[_Block]] = {}
    for b in blocks:
        by_key.setdefault(b.key, []).append(b)
    edits: list[tuple[int, int, list[str]]] = []
    appended: list[str] = []
    for key in old:
        if key not in new:
            edits += [(b.start, b.end, []) for b in by_key.get(key, [])]
    for key, value in new.items():
        if key in old and old[key] == to_raw(value):
            continue
        found = by_key.get(key)
        if not found:
            appended += render_entry(key, value)
            continue
        edits.append((found[0].start, found[0].end, render_entry(key, value, found[0])))
        edits += [(b.start, b.end, []) for b in found[1:]]  # duplicate keys collapse into the first
    lines = list(fm_lines)
    for start, end, repl in sorted(edits, key=lambda e: e[0], reverse=True):
        lines[start:end] = repl
    if appended:
        at = len(lines)
        while at > 0 and not lines[at - 1].strip():
            at -= 1
        lines[at:at] = appended
    return lines


def render_frontmatter(data: dict[str, Any]) -> list[str]:
    return [line for key, value in data.items() for line in render_entry(key, value)]


def _checked(note: NoteText, expected: dict[str, Any], body: str) -> bytes | None:
    out = note.to_bytes()
    # Limits first: parse() would reject the result, and that is not a YAML problem.
    if len(out) > MAX_NOTE_BYTES:
        raise NoteTooLarge(f"the note would be larger than {MAX_NOTE_BYTES // (1024 * 1024)} MiB")
    if sum(len(line) + 1 for line in note.fm_lines) > MAX_FRONTMATTER_CHARS:
        raise NoteTooLarge(f"the frontmatter would be larger than {MAX_FRONTMATTER_CHARS // 1024} KiB")
    try:
        parsed = parse(out)
    except FrontmatterError:
        return None
    return out if parsed.has_frontmatter and parsed.data == expected and parsed.body == body else None


def _finish(note: NoteText, lines: list[str] | None, new: dict[str, Any], body: str) -> bytes:
    expected = to_raw(new)
    if lines is not None and (out := _checked(replace(note, fm_lines=tuple(lines), body=body), expected, body)):
        return out
    full = render_frontmatter(new)
    if out := _checked(replace(note, fm_lines=tuple(full), body=body), expected, body):
        return out
    raise NoteEditError("a frontmatter value can't be written as YAML that reads back the same")


# --- operations ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Edited:
    raw: bytes
    data: dict[str, Any]  # frontmatter as it will read back (strings)
    old_data: dict[str, Any]


def edit_note(raw: bytes, frontmatter_patch: dict[str, Any] | None, body: str | None) -> Edited:
    """Apply a JSON Merge Patch to the frontmatter and/or replace the body."""
    note = split_note(raw)
    old = parse(raw).data
    new = merge_patch(old, frontmatter_patch) if frontmatter_patch else dict(old)
    new_body = normalise_newlines(body) if body is not None else note.body
    lines: list[str] | None
    try:
        lines = edit_frontmatter(list(note.fm_lines), old, new) if frontmatter_patch else list(note.fm_lines)
    except _NeedFullRender:
        lines = None
    out = _finish(note, lines, new, new_body)
    return Edited(out, to_raw(new), old)


def insert_first_key(raw: bytes, key: str, value: str) -> bytes:
    """Put `key: value` on the first frontmatter line (adoption writes `housebook_id`)."""
    note = split_note(raw)
    old = parse(raw).data
    if key in old:
        raise NoteEditError(f"'{key}' is already set")
    new = {key: value, **old}
    return _finish(note, [*render_entry(key, value), *note.fm_lines], new, note.body)


def build_note(data: dict[str, Any], body: str) -> bytes:
    note = NoteText(False, False, "---", (), "---", "")
    return _finish(note, render_frontmatter(data), data, normalise_newlines(body))


def log_line(day: date, text: str) -> str:
    return f"- {day.isoformat()} {' '.join(text.split())}"


def append_log(body: str, day: date, text: str) -> str:
    """Append `- YYYY-MM-DD text` at the end of the first "Maintenance log" section (any heading
    level, case-insensitive, up to the next heading of the same or a higher level); add the
    section at the end of the body if there is none."""
    entry = log_line(day, text)
    lines = body.split("\n")
    start: int | None = None
    level = 0
    end = len(lines)
    for i, line in enumerate(lines):
        m = _HEADING_RE.match(line)
        if not m:
            continue
        if start is None:
            if m[2].strip().casefold() == LOG_HEADING.casefold():
                start, level = i, len(m[1])
        elif len(m[1]) <= level:
            end = i
            break
    if start is None:
        base = body.rstrip("\n")
        return (base + "\n\n" if base.strip() else "\n") + f"## {LOG_HEADING}\n{entry}\n"
    at = start + 1
    for i in range(start + 1, end):
        if lines[i].strip():
            at = i + 1
    lines.insert(at, entry)
    out = "\n".join(lines)
    return out if out.endswith("\n") else out + "\n"
