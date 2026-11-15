"""Export (milestone 13, D49): the data folder as one zip file, written while it is sent.

Nothing is buffered beyond one chunk: `zipfile` writes to a sink that can't seek, so every
entry gets a data descriptor after its bytes, and zip64 is used for files near 4 GiB. Each file
is read as it is at that moment. The server replaces files by rename, so every file in the zip is
whole, but an edit made during a long export may land in some files and not others.

What goes in: every regular file under the data root, except
- names the scanner ignores (dot-files and dot-folders such as `.git`, `.obsidian`, `.trash`;
  `*.tmp`, `*~`, ...), with one exception: from `.housebook/` only `history/`, `trash/` and
  `calendar-links.json`, i.e. the earlier layouts, deleted notes and calendar links;
- symbolic links (never followed, so nothing outside the data root can end up in the zip).
Left out on purpose: the process lock, unfinished uploads, and `session-key`: whoever holds it
could make a login cookie for anyone, and a restore without it only means signing in again.
"""

import errno
import logging
import os
import stat
import time
import zipfile
from collections.abc import Iterator
from pathlib import Path

from housebook.domain.paths import is_ignored_name

log = logging.getLogger(__name__)

STATE_DIR = ".housebook"
STATE_KEPT = frozenset({"history", "trash", "calendar-links.json"})
# Already compressed: stored as they are, which saves time on a small server and loses nothing.
STORED_SUFFIXES = frozenset(
    {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".pdf", ".zip", ".gz", ".7z", ".mp4", ".mov"}
)
CHUNK = 256 * 1024


def export_files(root: Path) -> Iterator[tuple[Path, str]]:
    """(path on disk, name in the zip) for every file to export, in a stable order."""
    yield from _walk(root, "", top=True)


def _walk(folder: Path, prefix: str, top: bool = False) -> Iterator[tuple[Path, str]]:
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except FileNotFoundError:  # removed while exporting
        return
    for entry in entries:
        name = prefix + entry.name
        if entry.is_symlink():
            continue
        if top and entry.name == STATE_DIR:
            if entry.is_dir(follow_symlinks=False):
                yield from _walk_state(Path(entry.path), name + "/")
            continue
        if is_ignored_name(entry.name):
            continue
        if entry.is_dir(follow_symlinks=False):
            yield from _walk(Path(entry.path), name + "/")
        elif entry.is_file(follow_symlinks=False):
            yield Path(entry.path), name


def _walk_state(folder: Path, prefix: str) -> Iterator[tuple[Path, str]]:
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except FileNotFoundError:
        return
    for entry in entries:
        if entry.name not in STATE_KEPT or entry.is_symlink():
            continue
        if entry.is_dir(follow_symlinks=False):
            yield from _walk(Path(entry.path), prefix + entry.name + "/")
        elif entry.is_file(follow_symlinks=False):
            yield Path(entry.path), prefix + entry.name


class _Sink:
    """A write-only file for `zipfile`: collects bytes until the generator hands them on.
    It has `tell` but no `seek`, which makes `zipfile` stream (data descriptors)."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []
        self._pending = 0
        self._pos = 0

    def write(self, data: bytes) -> int:
        self._parts.append(bytes(data))
        self._pending += len(data)
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    @property
    def pending(self) -> int:
        return self._pending

    def take(self) -> bytes:
        out = b"".join(self._parts)
        self._parts.clear()
        self._pending = 0
        return out


def _zip_time(mtime: float) -> tuple[int, int, int, int, int, int]:
    """Zip timestamps are local time between 1980 and 2107 (the container's zone, UTC by default)."""
    t = time.localtime(mtime)[:6]
    if t[0] < 1980:
        return (1980, 1, 1, 0, 0, 0)
    if t[0] > 2107:
        return (2107, 12, 31, 23, 59, 58)
    return t  # type: ignore[return-value]


def export_zip(root: Path) -> Iterator[bytes]:
    """The zip, in chunks of about CHUNK bytes. Raises (ending the download as failed) when a
    file can't be read, rather than leaving it out of a backup without a word."""
    sink = _Sink()
    files = 0
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:  # type: ignore[arg-type]
        for path, name in export_files(root):
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            except FileNotFoundError:  # deleted since it was listed
                continue
            except OSError as e:
                if e.errno == errno.ELOOP:  # it became a symlink since it was listed
                    continue
                raise
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode):
                    continue
                info = zipfile.ZipInfo(name, date_time=_zip_time(st.st_mtime))
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.file_size = st.st_size  # decides zip64 up front
                stored = Path(name).suffix.lower() in STORED_SUFFIXES
                info.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
                with zf.open(info, "w", force_zip64=st.st_size > zipfile.ZIP64_LIMIT // 2) as out:
                    while chunk := f.read(CHUNK):
                        out.write(chunk)
                        if sink.pending >= CHUNK:
                            yield sink.take()
            files += 1
            if sink.pending >= CHUNK:
                yield sink.take()
    if sink.pending:
        yield sink.take()
    log.info("export finished", extra={"files": files, "bytes": sink.tell()})
