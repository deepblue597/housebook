"""Export: the data folder as a streamed zip (milestone 13, D49, data contract §12)."""

import io
import os
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import ClientFactory
from housebook.services.export import CHUNK, export_files, export_zip


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def _zip(body: bytes) -> zipfile.ZipFile:
    zf = zipfile.ZipFile(io.BytesIO(body))
    assert zf.testzip() is None  # every CRC checks out
    return zf


def _files_on_disk(root: Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and ".housebook" not in p.parts}


def test_export_is_the_data_folder(example_root: Path, editor: TestClient):
    r = editor.get("/api/export", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="housebook-20261104-100000Z.zip"'
    assert r.headers["cache-control"] == "no-store"
    assert "content-encoding" not in r.headers  # a zip is never gzipped again
    zf = _zip(r.content)
    names = set(zf.namelist())
    assert "house.json" in names and _files_on_disk(example_root) <= names
    for name in names - {n for n in names if n.startswith(".housebook/")}:
        assert zf.read(name) == (example_root / name).read_bytes(), name


def test_export_keeps_history_trash_and_calendar_links_but_not_secrets(example_root: Path, editor: TestClient):
    state = example_root / ".housebook"
    (state / "history").mkdir()
    (state / "history" / "house-20261101T000000Z.json").write_text("{}")
    (state / "trash" / "20261101T000000Z-it_abc123").mkdir(parents=True)
    (state / "trash" / "20261101T000000Z-it_abc123" / "Old.md").write_text("old")
    (state / "calendar-links.json").write_text('{"version": 1, "links": {}}')
    (state / "session-key").write_bytes(b"k" * 32)
    (state / "uploads").mkdir()
    (state / "uploads" / "half.part").write_bytes(b"x")
    (state / "index.db").write_bytes(b"cache")

    names = set(_zip(editor.get("/api/export").content).namelist())
    assert {
        ".housebook/history/house-20261101T000000Z.json",
        ".housebook/trash/20261101T000000Z-it_abc123/Old.md",
        ".housebook/calendar-links.json",
    } <= names
    assert not {n for n in names if n.startswith(".housebook/")} - {
        ".housebook/history/house-20261101T000000Z.json",
        ".housebook/trash/20261101T000000Z-it_abc123/Old.md",
        ".housebook/calendar-links.json",
    }  # no lock, session key, uploads or cache


def test_export_skips_hidden_temporary_and_linked_files(example_root: Path, tmp_path: Path, editor: TestClient):
    (example_root / ".git").mkdir()
    (example_root / ".git" / "HEAD").write_text("ref: refs/heads/main")
    (example_root / ".obsidian").mkdir()
    (example_root / ".obsidian" / "app.json").write_text("{}")
    (example_root / "House" / "draft.md.tmp").write_text("x")
    (example_root / "House" / ".DS_Store").write_bytes(b"x")
    secret = tmp_path / "secret.txt"
    secret.write_text("outside the data folder")
    (example_root / "House" / "link.md").symlink_to(secret)
    (example_root / "outside").symlink_to(tmp_path, target_is_directory=True)

    names = _zip(editor.get("/api/export").content).namelist()
    assert not [n for n in names if n.startswith((".git/", ".obsidian/", "outside"))]
    assert not [n for n in names if n.endswith((".tmp", ".DS_Store", "link.md"))]


def test_export_needs_an_editor(example_root: Path, make_client: ClientFactory):
    assert make_client(example_root, anon_role="viewer").get("/api/export").status_code == 403


def test_head_answers_without_building_the_zip(editor: TestClient):
    r = editor.head("/api/export")
    assert r.status_code == 200 and r.content == b""
    assert r.headers["content-disposition"].startswith('attachment; filename="housebook-')


def test_large_and_binary_files_stream_in_chunks(tmp_path: Path):
    root = tmp_path / "data"
    (root / "House" / "Boiler").mkdir(parents=True)
    big = os.urandom(3 * CHUNK + 17)
    (root / "House" / "Boiler" / "manual.pdf").write_bytes(big)
    (root / "House" / "Boiler.md").write_text("# Boiler\n" * 5000)
    (root / "Ünïcode name.md").write_text("ok")

    chunks = list(export_zip(root))
    assert len(chunks) > 3 and all(chunks)
    zf = _zip(b"".join(chunks))
    assert zf.read("House/Boiler/manual.pdf") == big
    assert zf.getinfo("House/Boiler/manual.pdf").compress_type == zipfile.ZIP_STORED
    assert zf.getinfo("House/Boiler.md").compress_type == zipfile.ZIP_DEFLATED
    assert zf.read("Ünïcode name.md") == b"ok"


def test_order_is_stable(example_root: Path):
    names = [n for _, n in export_files(example_root)]
    assert names == sorted(names, key=lambda n: n.split("/")) and names


def test_a_file_that_cant_be_read_fails_the_export(tmp_path: Path):
    if os.geteuid() == 0:
        pytest.skip("root reads everything")
    root = tmp_path / "data"
    root.mkdir()
    (root / "house.json").write_text("{}")
    locked = root / "receipt.pdf"
    locked.write_bytes(b"%PDF")
    locked.chmod(0)
    try:
        with pytest.raises(PermissionError):
            list(export_zip(root))
    finally:
        locked.chmod(0o644)


def test_old_timestamps_still_fit(tmp_path: Path):
    root = tmp_path / "data"
    root.mkdir()
    old = root / "old.md"
    old.write_text("1970")
    os.utime(old, (0, 0))
    assert _zip(b"".join(export_zip(root))).getinfo("old.md").date_time == (1980, 1, 1, 0, 0, 0)
