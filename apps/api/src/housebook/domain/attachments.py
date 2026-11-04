"""Attachment resolution (DESIGN 15.3). Pure: works on a list of relative file paths.

An item's attachments are the union of
- links listed in frontmatter `attachments` (wikilinks like `[[Dishwasher/manual.pdf]]`), and
- files directly inside the sibling folder named after the note (`Kitchen/Dishwasher/`).

A link resolves, in order: relative to the note's folder, relative to the data root, then a
unique file-name match anywhere under the data root. All comparisons are on NFC forms.
"""

import posixpath
import re
from dataclasses import dataclass

from housebook.domain.text import nfc

_WIKILINK_RE = re.compile(r"^!?\[\[(.+?)\]\]$")


@dataclass(frozen=True)
class FileIndex:
    by_path: dict[str, str]  # NFC rel path -> actual rel path
    by_name: dict[str, list[str]]  # NFC basename -> actual rel paths
    by_dir: dict[str, list[str]]  # NFC parent dir -> actual rel paths
    outside: frozenset[str] = frozenset()  # NFC rel paths of symlinks escaping the root

    @classmethod
    def build(cls, rels: list[str], outside: list[str] | tuple[str, ...] = ()) -> "FileIndex":
        by_path: dict[str, str] = {}
        by_name: dict[str, list[str]] = {}
        by_dir: dict[str, list[str]] = {}
        for rel in rels:
            key = nfc(rel)
            by_path[key] = rel
            parent, name = posixpath.split(key)
            by_name.setdefault(name, []).append(rel)
            by_dir.setdefault(parent, []).append(rel)
        return cls(by_path, by_name, by_dir, frozenset(nfc(r) for r in outside))


def link_target(link: str) -> str:
    """`[[a/b.pdf|Manual]]` -> `a/b.pdf`; plain strings are taken as paths."""
    s = link.strip()
    m = _WIKILINK_RE.match(s)
    if m:
        s = m[1]
    s = s.split("|", 1)[0]
    s = s.split("#", 1)[0]  # heading/block refs
    return s.strip()


class LinkError(ValueError):
    def __init__(self, message: str, unsafe: bool = False) -> None:
        super().__init__(message)
        self.unsafe = unsafe


def resolve_link(files: FileIndex, note_rel: str, link: str) -> str:
    """Actual relative path of the file a link points to. Raises LinkError."""
    target = nfc(link_target(link)).replace("\\", "/")
    if not target:
        raise LinkError("empty link")
    if target.startswith("/"):
        target = target.lstrip("/")
    note_dir = posixpath.dirname(nfc(note_rel))
    for candidate in (posixpath.join(note_dir, target), target):
        norm = posixpath.normpath(candidate)
        if norm == ".." or norm.startswith("../"):
            raise LinkError("link points outside the data root", unsafe=True)
        if norm in files.outside:
            raise LinkError("link is a symlink pointing outside the data root", unsafe=True)
        if norm in files.by_path:
            return files.by_path[norm]
    if "/" not in target:
        matches = files.by_name.get(target, [])
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise LinkError(f"'{target}' matches {len(matches)} files; use a path")
        if any(posixpath.basename(o) == target for o in files.outside):
            raise LinkError("link resolves to a symlink pointing outside the data root", unsafe=True)
    raise LinkError("file not found")


def sibling_files(files: FileIndex, note_rel: str) -> list[str]:
    """Files directly inside the folder named after the note (`House/K/Dishwasher/`)."""
    folder = nfc(note_rel)
    if folder.lower().endswith(".md"):
        folder = folder[:-3]
    return sorted(r for r in files.by_dir.get(folder, []) if not r.lower().endswith(".md"))
