"""Regression tests for the tester round (HB-xx) spec gaps not covered by the tester's own tests."""

import gzip
import ipaddress
import json
import mimetypes
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import StreamingResponse
from starlette.routing import Route

import vault_builders as vb
from conftest import ClientFactory
from housebook.api.middleware import GZIP_EXCLUDED
from housebook.config import ConfigError, Settings
from housebook.domain.catalog import Catalog
from housebook.domain.filetypes import sniff
from housebook.domain.frontmatter import FrontmatterError, parse
from housebook.domain.house import normalise_cells

# --- gzip --------------------------------------------------------------------------------


def test_json_is_gzipped_files_are_not(client: TestClient):
    r = client.get("/api/snapshot", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip" and "accept-encoding" in r.headers["vary"].lower()
    assert r.json()["items"]  # httpx decodes transparently
    etag = r.headers["etag"]
    assert client.get("/api/snapshot", headers={"If-None-Match": etag, "Accept-Encoding": "gzip"}).status_code == 304
    pdf = client.get("/api/items/it_7f3k2a/attachments/manual.pdf", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in pdf.headers
    part = client.get(
        "/api/items/it_7f3k2a/attachments/manual.pdf", headers={"Accept-Encoding": "gzip", "Range": "bytes=0-3"}
    )
    assert part.status_code == 206 and "content-encoding" not in part.headers and part.content == b"%PDF"


def test_gzip_never_touches_event_streams():
    async def events(_request):
        return StreamingResponse(iter([b"data: " + b"x" * 4000 + b"\n\n"]), media_type="text/event-stream")

    app = Starlette(
        routes=[Route("/events", events)],
        middleware=[Middleware(GZipMiddleware, minimum_size=1024, exclude_content_types=GZIP_EXCLUDED)],
    )
    r = TestClient(app).get("/events", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers and r.text.startswith("data: ")


def test_gzip_ratio_on_a_big_snapshot(tmp_path: Path, make_client: ClientFactory):
    vb.build_bulk(tmp_path / "bulk", n=100)
    c = make_client(tmp_path / "bulk")
    raw = c.get("/api/snapshot", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in raw.headers
    assert len(gzip.compress(raw.content)) < len(raw.content) / 4


# --- HEAD --------------------------------------------------------------------------------


def test_head_matches_get_headers_without_body(client: TestClient):
    for path in ["/api/snapshot", "/api/items/it_7f3k2a/attachments/manual.pdf", "/"]:
        get, head = client.get(path), client.head(path)
        assert head.status_code == 200 and head.content == b"", path
        assert head.headers.get("etag") == get.headers.get("etag"), path
        assert head.headers["content-type"] == get.headers["content-type"], path
    assert client.head("/api/items/it_nope").status_code == 404


# --- search q --------------------------------------------------------------------------


@pytest.mark.parametrize("q", ["", "   ", "\t"])
def test_blank_query_matches_nothing(client: TestClient, q: str):
    assert client.get("/api/items", params={"q": q}).json() == {"items": [], "count": 0}
    assert client.get("/api/items").json()["count"] == 14  # no q at all still lists everything


# --- groups ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "groups, role",
    [
        ("/home/housebook-editors", "editor"),
        ("/org/home/housebook-editors", "editor"),
        ("/home/Housebook-Editors", "viewer"),  # case-sensitive
        ("/home/housebook-editors/sub", "viewer"),
        ("/home/xhousebook-editors", "viewer"),
    ],
)
def test_nested_keycloak_groups(example_root: Path, make_client: ClientFactory, groups: str, role: str):
    c = make_client(
        example_root, client_host="10.0.0.5", auth_mode="proxy", trusted_proxies=(ipaddress.ip_network("10.0.0.5"),)
    )
    r = c.get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": groups})
    assert r.json()["role"] == role


def test_docs_still_served_in_none_mode(client: TestClient):
    assert "/api/snapshot" in client.get("/api/openapi.json").json()["paths"]
    assert "swagger" in client.get("/api/docs").text.lower()


# --- content sniffing -------------------------------------------------------------------


@pytest.mark.parametrize(
    "head, expected",
    [
        (b"%PDF-1.7\n", "application/pdf"),
        (b"\x89PNG\r\n\x1a\n\x00\x00", "image/png"),
        (b"\xff\xd8\xff\xe0\x00\x10JFIF", "image/jpeg"),
        (b"GIF89a....", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),
        (b"\x00\x00\x00\x18ftypheic\x00\x00", "image/heic"),
        (b"<html><script>", None),
        (b"", None),
    ],
)
def test_sniff(head: bytes, expected: str | None):
    assert sniff(head) == expected


def test_attachment_type_comes_from_bytes(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", "name: A")
    vb.write(root, "House/it_a/not-really.pdf", b"<html><script>alert(1)</script></html>")
    vb.write(root, "House/it_a/photo.bin", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8)
    vb.write(root, "House/it_a/scan.jpg", vb.PDF)  # a PDF with the wrong extension
    vb.write(root, "House/it_a/iphone.heic", b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00")
    c = make_client(root)
    base = "/api/items/it_a/attachments/"
    r = c.get(base + "not-really.pdf")
    assert r.headers["content-type"] == "application/octet-stream" and r.headers["content-disposition"].startswith(
        "attachment"
    )
    assert "sandbox" in r.headers["content-security-policy"]
    r = c.get(base + "photo.bin")
    assert r.headers["content-type"] == "image/png" and r.headers["content-disposition"].startswith("inline")
    r = c.get(base + "scan.jpg")
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    r = c.get(base + "iphone.heic")
    assert r.headers["content-type"] == "image/heic" and r.headers["content-disposition"].startswith("attachment")


# --- hostile frontmatter ---------------------------------------------------------------


@pytest.mark.parametrize(
    "fm, message",
    [
        ("a: &x [1, 2]\nb: *x", "aliases"),
        ("x: " + "[" * 40 + "]" * 40, "nested deeper"),
        ("x: [" + ",".join(["1"] * 10_001) + "]", "more than"),
        ("x: '" + "y" * 70_000 + "'", "larger than"),
    ],
)
def test_frontmatter_limits(fm: str, message: str):
    with pytest.raises(FrontmatterError, match=message):
        parse(f"---\n{fm}\n---\n".encode())


def test_anchor_without_alias_is_fine():
    assert parse(b"---\na: &x 1\n---\n").data == {"a": "1"}


def test_huge_note_is_a_parse_error():
    with pytest.raises(FrontmatterError, match="larger than"):
        parse(b"---\nname: x\n---\n" + b"y" * (4 * 1024 * 1024))


# --- unreadable folders ------------------------------------------------------------------


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_unreadable_folder_keeps_last_good(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    vb.write_house(root, vb.house(placements=[{"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0}]))
    vb.item(root, "it_a", "name: A", rel="House/Kitchen/A.md")
    c = make_client(root)
    folder = root / "House/Kitchen"
    folder.chmod(0)
    try:
        c.app.state.ctx.indexer.scan()
        item = c.get("/api/items/it_a").json()
        assert item["stale"] is True and item["name"] == "A"
        kinds = [(p["kind"], p["path"]) for p in c.get("/api/problems").json()["problems"]]
        assert ("read_error", "House/Kitchen") in kinds and not any(k == "missing_note" for k, _ in kinds)
    finally:
        folder.chmod(0o755)
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/items/it_a").json()["stale"] is False


# --- house.json cells, size, versions -----------------------------------------------------


def test_cell_keys_are_normalised_on_load(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    cells = {"0,0": "r1", "01,0": "r1", " 2 , 1": "r1", "0,00": "r1", "x,y": "r1", "-1,0": "r1"}
    vb.write_house(root, vb.house(floors=[{"id": "f1", "name": "G", "cells": cells}]))
    c = make_client(root)
    assert c.get("/api/house").json()["floors"][0]["cells"] == {"0,0": "r1", "1,0": "r1", "2,1": "r1"}
    bad = [p["message"] for p in c.get("/api/problems").json()["problems"] if p["kind"] == "house_bad_cell"]
    assert len(bad) == 5


def test_normalise_cells_leaves_non_houses_alone():
    assert normalise_cells([1, 2]) == ([1, 2], [])
    assert normalise_cells({"floors": "nope"}) == ({"floors": "nope"}, [])


def test_newer_version_keeps_last_good_layout_read_only(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    vb.write_house(root, vb.house())
    c = make_client(root)
    vb.write_house(root, vb.house(schemaVersion=3, grid={"cols": 4}))
    c.app.state.ctx.indexer.scan()
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["houseSchemaVersion"] == 3 and snap["house"]["grid"]["width"] == 4
    kinds = {p["kind"] for p in c.get("/api/problems").json()["problems"]}
    assert {"house_newer_version", "house_invalid"} <= kinds


def test_footprint_must_be_positive_in_catalog_too():
    t = {"key": "a", "label": "A", "defaultName": "A", "mount": "floor", "footprint": [0, 1]}
    with pytest.raises(ValueError):
        Catalog.model_validate({"types": [t]})


def test_house_json_size_cap(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    data = vb.house()
    data["rooms"][0]["name"] = "x" * 50
    text = json.dumps(data)
    vb.write_house(root, text[:-1] + ', "pad": "' + "y" * (16 * 1024 * 1024) + '"}')
    kinds = [p["message"] for p in make_client(root).get("/api/problems").json()["problems"]]
    assert any("larger than" in m for m in kinds)


# --- config ------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [".", "./", "a/../b", ".."])
def test_notes_dir_must_be_a_subfolder(value: str):
    with pytest.raises(ConfigError, match="subfolder"):
        Settings.from_env({"HOUSEBOOK_NOTES_DIR": value})


def test_notes_dir_is_normalised_and_empty_means_default():
    assert Settings.from_env({"HOUSEBOOK_NOTES_DIR": "./Notes/Home/"}).notes_dir == "Notes/Home"
    s = Settings.from_env({"HOUSEBOOK_NOTES_DIR": " ", "HOUSEBOOK_DATA_DIR": ""})
    assert s.notes_dir == "House" and str(s.data_dir) == "/data"


# --- round 2 (HB-12..HB-15 and the coordinator's decisions) -------------------------------


@pytest.mark.parametrize(
    "header, ok",
    [
        ("gzip", True),
        ("gzip, deflate, br", True),
        ("gzip;q=0", False),
        ("gzip; q=0.0, identity", False),
        ("GZIP;Q=0.5", True),
        ("*", True),
        ("*;q=0", False),
        ("identity", False),
        ("gzip;q=0, *", False),  # an explicit gzip entry wins over *
        ("", False),
    ],
)
def test_accepts_gzip(header: str, ok: bool):
    from housebook.api.middleware import accepts_gzip

    assert accepts_gzip(header) is ok


def test_file_version_etags_stay_strong_and_uncompressed(client: TestClient):
    gz = {"Accept-Encoding": "gzip"}
    house = client.get("/api/house", headers=gz)
    item = client.get("/api/items/it_7f3k2a", headers=gz)
    for r in (house, item):
        assert "content-encoding" not in r.headers and not r.headers["etag"].startswith("W/")
    assert item.headers["etag"] == f'"{item.json()["etag"]}"'
    assert client.get("/api/snapshot", headers=gz).headers["etag"].startswith("W/")
    assert not client.get("/api/snapshot", headers={"Accept-Encoding": "identity"}).headers["etag"].startswith("W/")


@pytest.mark.parametrize(
    "configured, groups, role",
    [
        ("/home/housebook-editors", "/home/housebook-editors", "editor"),
        ("/home/housebook-editors", "/kids/housebook-editors", "viewer"),
        ("/home/housebook-editors", "housebook-editors", "viewer"),
        ("/home/housebook-editors", "/home/housebook-editors/sub", "viewer"),
        ("housebook-editors", "/kids/housebook-editors", "editor"),  # bare name: any depth
    ],
)
def test_editor_group_full_path_vs_bare_name(
    example_root: Path, make_client: ClientFactory, configured: str, groups: str, role: str
):
    c = make_client(
        example_root,
        client_host="10.0.0.5",
        auth_mode="proxy",
        trusted_proxies=(ipaddress.ip_network("10.0.0.5"),),
        editor_group=configured,
    )
    r = c.get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": groups})
    assert r.json()["role"] == role


@pytest.mark.parametrize(
    "version, why",
    [("2", 'got "2"'), (2.5, "got 2.5"), (None, "got missing"), (True, "got true"), (0, "got 0")],
)
def test_house_writable_only_when_current_and_valid(tmp_path: Path, make_client: ClientFactory, version, why: str):
    root = tmp_path / "data"
    data = vb.house(schemaVersion=version)
    if version is None:
        del data["schemaVersion"]
    vb.write_house(root, data)
    c = make_client(root)
    assert c.get("/api/snapshot").json()["houseReadOnly"] is True
    [p] = c.get("/api/problems").json()["problems"]
    assert p["kind"] == "house_invalid" and why in p["message"] and "read-only" in p["message"]


def test_house_read_only_states(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "data"
    vb.write_house(root, vb.house())
    c = make_client(root)
    assert c.get("/api/snapshot").json()["houseReadOnly"] is False  # valid, current: writable
    vb.write_house(root, '{"schemaVersion": 1, "grid": ')  # broken: last good kept, read-only
    c.app.state.ctx.indexer.scan()
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["house"] is not None
    (root / "house.json").unlink()  # missing: nothing to protect, first run will create it
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/snapshot").json()["houseReadOnly"] is False


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_unreadable_attachment_is_a_problem(example_root: Path, make_client: ClientFactory):
    path = example_root / "House/Kitchen/Dishwasher/manual.pdf"
    path.chmod(0)
    try:
        c = make_client(example_root)
        assert [a["name"] for a in c.get("/api/items/it_7f3k2a").json()["attachments"]] == ["receipt.png"]
        probs = c.get("/api/problems").json()["problems"]
        assert [(p["kind"], p["path"], p["itemId"]) for p in probs] == [
            ("read_error", "House/Kitchen/Dishwasher/manual.pdf", "it_7f3k2a")
        ]
        r = c.get("/api/items/it_7f3k2a/attachments/manual.pdf")
        assert r.status_code == 404 and "Kitchen" not in r.text
    finally:
        path.chmod(0o644)


@pytest.mark.parametrize("value", [".hb", "House/.obsidian", "Notes~", "x.tmp"])
def test_notes_dir_hidden_or_temp_names_rejected(value: str):
    with pytest.raises(ConfigError, match="hidden or temporary"):
        Settings.from_env({"HOUSEBOOK_NOTES_DIR": value})


# --- HB-16: SPA conditional GET; PDFs sandboxed ------------------------------------------


@pytest.fixture
def spa_client(example_root: Path, make_client: ClientFactory, tmp_path: Path) -> TestClient:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Housebook</title>" + "<!-- pad -->" * 200)
    (web / "assets" / "index-B4x9KqZ1.js").write_text("console.log(1);" * 200)
    return make_client(example_root, static_dir=web)


@pytest.mark.parametrize(
    "path, cache",
    [
        ("/", "no-cache"),
        ("/i/it_7f3k2a", "no-cache"),
        ("/assets/index-B4x9KqZ1.js", "public, max-age=31536000, immutable"),
    ],
)
@pytest.mark.parametrize("encoding", ["identity", "gzip"])
def test_spa_files_answer_304(spa_client: TestClient, path: str, cache: str, encoding: str):
    first = spa_client.get(path, headers={"Accept-Encoding": encoding})
    etag = first.headers["etag"]
    assert etag.startswith("W/") is (encoding == "gzip")
    r = spa_client.get(path, headers={"Accept-Encoding": encoding, "If-None-Match": etag})
    assert r.status_code == 304 and r.content == b""
    assert r.headers["etag"] == etag and r.headers["cache-control"] == cache
    assert "accept-encoding" in r.headers["vary"].lower()
    assert spa_client.get(path, headers={"If-None-Match": '"other"'}).status_code == 200


@pytest.mark.parametrize(
    "name, media_type", [("house-Ab3dE9fG.glb", "model/gltf-binary"), ("house-Ab3dE9fG.gltf", "model/gltf+json")]
)
def test_spa_gltf_media_types_ignore_host_mime_db(
    spa_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, media_type: str
):
    # Simulate the slim image: only Python's built-in table, no /etc/mime.types.
    monkeypatch.setattr(mimetypes, "_db", mimetypes.MimeTypes(filenames=()))
    assert mimetypes.guess_type(name) == (None, None)
    (tmp_path / "web" / "assets" / name).write_bytes(b"glTF\x02\x00\x00\x00")
    r = spa_client.get(f"/assets/{name}")
    assert r.status_code == 200 and r.headers["content-type"] == media_type
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_pdf_is_sandboxed_and_range_still_works(client: TestClient):
    url = "/api/items/it_7f3k2a/attachments/manual.pdf"
    r = client.get(url, headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert r.headers["x-content-type-options"] == "nosniff" and "content-encoding" not in r.headers
    assert r.headers["accept-ranges"] == "bytes" and not r.headers["etag"].startswith("W/")
    part = client.get(url, headers={"Range": "bytes=0-4", "Accept-Encoding": "gzip", "If-Range": r.headers["etag"]})
    assert part.status_code == 206 and part.content == b"%PDF-"
    assert part.headers["content-security-policy"] == "default-src 'none'; sandbox"
