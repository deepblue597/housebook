"""Tester suite, round 2: probes of the HB-01..HB-11 fixes for bypasses and regressions.

New bugs are strict xfails tagged HB-12 and later.
"""

import ipaddress
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import vault_builders as vb
from housebook.api.app import create_app
from housebook.config import ConfigError, Settings

REPO = Path(__file__).resolve().parents[4]
CONTRACT = REPO / "contract"
ATT = "/api/items/it_7f3k2a/attachments/"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "data"


def problems(c: TestClient) -> list[tuple[str, str | None, str]]:
    return [(p["kind"], p.get("path"), p["message"]) for p in c.get("/api/problems").json()["problems"]]


# --- HB-02 / HB-03: YAML caps and aliases ------------------------------------------------------------


@pytest.mark.parametrize(
    "fm",
    [
        pytest.param("base: &b {brand: Bosch}\nother:\n  <<: *b\n  model: y", id="merge-key"),
        pytest.param("a: &k foo\n*k : bar", id="alias-as-key"),
        pytest.param("t0: &t housebook\ntags: [*t]", id="alias-in-tags"),
        pytest.param(vb.alias_bomb(levels=1, fanout=2), id="tiny-alias"),
    ],
)
def test_every_alias_form_is_a_parse_error(root: Path, make_client, fm: str):
    vb.write_house(root, vb.house())
    vb.item(root, "it_x", "name: X\n" + fm, rel="House/X.md")
    c = make_client(root)
    assert c.get("/api/items/it_x").status_code == 404
    assert [(k, p) for k, p, _ in problems(c)] == [("note_parse_error", "House/X.md")]


def test_anchor_without_alias_is_fine(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_x", "name: X\nbase: &b {brand: Bosch}")
    assert make_client(root).get("/api/items/it_x").json()["frontmatter"]["base"] == {"brand": "Bosch"}


@pytest.mark.parametrize(
    "fm, ok",
    [
        ("x: " + "[" * 31 + "]" * 31, True),  # root mapping + 31 lists = 32 levels
        ("x: " + "[" * 32 + "]" * 32, False),
        ("x: " + "{a: " * 40 + "1" + "}" * 40, False),
        ("".join("  " * i + f"k{i}:\n" for i in range(40)) + "  " * 40 + "v: 1", False),
        ("x: [" + ",".join(["a"] * 9_990) + "]", True),
        ("x: [" + ",".join(["a"] * 10_000) + "]", False),
        ("x: " + "[" * 100_000 + "]" * 100_000, False),
    ],
    ids=["depth-32", "depth-33", "flow-map-40", "block-map-40", "9990-values", "10000-values", "depth-100k"],
)
def test_frontmatter_caps_at_the_boundary(root: Path, make_client, fm: str, ok: bool):
    vb.write_house(root, vb.house())
    vb.item(root, "it_ok", "name: Fine")
    vb.item(root, "it_x", "name: X\n" + fm, rel="House/X.md")
    c = make_client(root)
    assert c.get("/api/items/it_ok").status_code == 200
    assert (c.get("/api/items/it_x").status_code == 200) is ok
    assert c.get("/api/snapshot").status_code == 200


def test_note_size_cap_keeps_last_good(root: Path, make_client):
    vb.write_house(root, vb.house())
    path = vb.item(root, "it_x", "name: X")
    c = make_client(root)
    path.write_text(vb.note("housebook_id: it_x\nname: Y", "a" * (4 * 1024 * 1024 + 1)))
    c.app.state.ctx.indexer.scan()
    it = c.get("/api/items/it_x").json()
    assert it["stale"] is True and it["name"] == "X" and "4 MiB" in it["parseError"]


# --- HB-05: read-only detection -------------------------------------------------------------------------


def test_newer_unparseable_after_valid_keeps_last_layout_read_only(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", "name: A")
    c = make_client(root)
    vb.write_house(root, vb.house(schemaVersion=2, grid="huge"))
    c.app.state.ctx.indexer.scan()
    r = c.get("/api/house")
    assert r.status_code == 200 and r.headers["x-housebook-read-only"] == "true"
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["houseSchemaVersion"] == 2
    kinds = {k for k, _, _ in problems(c)}
    assert {"house_newer_version", "house_invalid"} <= kinds


@pytest.mark.parametrize(
    "mutate, why",
    [
        pytest.param(lambda d: d.update(schemaVersion="2"), "schemaVersion", id="version-string"),
        pytest.param(lambda d: d.update(schemaVersion=2.5), "schemaVersion", id="version-float"),
        pytest.param(lambda d: d.update(schemaVersion=1.0), "schemaVersion", id="version-1.0"),
        pytest.param(lambda d: d.pop("schemaVersion"), "schemaVersion", id="version-missing"),
        pytest.param(lambda d: d.update(schemaVersion=True), "schemaVersion", id="version-bool"),
        pytest.param(lambda d: d.update(schemaVersion=0), "schemaVersion", id="version-0"),
        pytest.param(lambda d: d.update(schemaVersion=-1), "schemaVersion", id="version-negative"),
        pytest.param(lambda d: d["grid"].update(width="wide"), "grid", id="current-version-invalid-grid"),
        pytest.param(lambda d: d.update(typo=1), "typo", id="current-version-unknown-key"),
    ],
)
def test_house_json_read_only_unless_current_and_valid(root: Path, make_client, mutate, why: str):
    """Product decision: house.json is writable only when it parses and validates as the
    current schemaVersion (an int equal to the supported version). Anything else is read-only
    with a problem saying why, so a PUT (milestone 4) never overwrites a layout it doesn't
    fully understand."""
    data = vb.house()
    mutate(data)
    vb.write_house(root, data)
    c = make_client(root)
    assert c.get("/api/house").status_code == 404  # nothing valid to show
    assert c.get("/api/snapshot").json()["houseReadOnly"] is True
    ps = problems(c)
    assert [k for k, _, _ in ps] == ["house_invalid"]
    assert why in ps[0][2] and "read-only" in ps[0][2]


def test_house_json_broken_after_valid_is_read_only_last_good(root: Path, make_client):
    vb.write_house(root, vb.house())
    c = make_client(root)
    assert c.get("/api/snapshot").json()["houseReadOnly"] is False
    for broken in ('{"schemaVersion": "1"', json.dumps(vb.house(schemaVersion="1")), ""):
        vb.write_house(root, broken)
        c.app.state.ctx.indexer.scan()
        r = c.get("/api/house")
        assert r.status_code == 200 and r.headers["x-housebook-read-only"] == "true", broken
        assert c.get("/api/snapshot").json()["houseReadOnly"] is True, broken
    vb.write_house(root, vb.house())
    c.app.state.ctx.indexer.scan()
    r = c.get("/api/house")
    assert "x-housebook-read-only" not in r.headers and c.get("/api/snapshot").json()["houseReadOnly"] is False


def test_house_json_newer_version_is_read_only(root: Path, make_client):
    vb.write_house(root, vb.house(schemaVersion=2))
    c = make_client(root)
    assert c.get("/api/snapshot").json()["houseReadOnly"] is True
    assert [k for k, _, _ in problems(c)] == ["house_newer_version"]


def test_house_json_missing_stays_writable(root: Path, make_client):
    vb.item(root, "it_a", "name: A")
    c = make_client(root)
    assert c.get("/api/house").status_code == 404
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is False and snap["house"] is None
    assert [k for k, _, _ in problems(c)] == ["house_missing"]


def test_house_json_current_and_valid_is_writable(root: Path, make_client):
    vb.write_house(root, vb.house())
    c = make_client(root)
    assert "x-housebook-read-only" not in c.get("/api/house").headers
    assert c.get("/api/snapshot").json()["houseReadOnly"] is False


# --- spec gap: canonical cell keys ----------------------------------------------------------------------


def test_loose_cell_keys_are_canonicalised_or_dropped(root: Path, make_client):
    cells = {"01,0": "r1", " 2,0": "r1", "0,00": "r1", "x,y": "r1", "1,1": "r1"}
    vb.write_house(root, vb.house(floors=[{"id": "f1", "name": "G", "cells": cells}]))
    c = make_client(root)
    served = c.get("/api/house").json()["floors"][0]["cells"]
    assert served == {"0,0": "r1", "1,0": "r1", "2,0": "r1", "1,1": "r1"}
    assert [k for k, _, _ in problems(c)].count("house_bad_cell") == 4


# --- HB-01: HEAD -----------------------------------------------------------------------------------------


def test_head_on_attachment_with_range(client: TestClient):
    r = client.head(ATT + "manual.pdf", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.content == b""
    assert r.headers["content-length"] == "10" and r.headers["content-range"].startswith("bytes 0-9/")


def test_head_matches_get_headers(client: TestClient):
    for path in ["/api/snapshot", "/api/house", "/api/items/nope", ATT + "manual.pdf"]:
        g, h = client.get(path), client.head(path)
        assert h.status_code == g.status_code and h.content == b"", path
        assert h.headers.get("etag") == g.headers.get("etag"), path


# --- spec gap: gzip ---------------------------------------------------------------------------------------


def test_gzip_on_json_only(client: TestClient):
    gz = {"Accept-Encoding": "gzip"}
    snap = client.get("/api/snapshot", headers=gz)
    assert snap.headers["content-encoding"] == "gzip" and "accept-encoding" in snap.headers["vary"].lower()
    assert len(snap.json()["items"]) == 14
    assert "content-encoding" not in client.get("/api/snapshot", headers={"Accept-Encoding": "identity"}).headers
    assert "content-encoding" not in client.get(ATT + "manual.pdf", headers=gz).headers
    assert "content-encoding" not in client.get(ATT + "receipt.png", headers=gz).headers
    part = client.get(ATT + "manual.pdf", headers={**gz, "Range": "bytes=0-99"})
    assert part.status_code == 206 and "content-encoding" not in part.headers
    etag = snap.headers["etag"]
    nm = client.get("/api/snapshot", headers={**gz, "If-None-Match": etag})
    assert nm.status_code == 304 and nm.content == b""


def test_gzip_q0_is_respected(client: TestClient):
    r = client.get("/api/snapshot", headers={"Accept-Encoding": "gzip;q=0, identity"})
    assert "content-encoding" not in r.headers


def test_gzip_and_identity_do_not_share_a_strong_etag(client: TestClient):
    a = client.get("/api/snapshot", headers={"Accept-Encoding": "gzip"}).headers["etag"]
    b = client.get("/api/snapshot", headers={"Accept-Encoding": "identity"}).headers["etag"]
    assert a != b or a.startswith("W/")


def test_304_carries_vary(client: TestClient):
    etag = client.get("/api/snapshot").headers["etag"]
    r = client.get("/api/snapshot", headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
    assert r.status_code == 304 and "accept-encoding" in r.headers.get("vary", "").lower()


# --- spec gap: sniffing -----------------------------------------------------------------------------------


def test_content_type_from_bytes_not_extension(example_root: Path, make_client):
    d = example_root / "House/Kitchen/Dishwasher"
    pdf, png = (d / "manual.pdf").read_bytes(), (d / "receipt.png").read_bytes()
    (d / "pdf-as.png").write_bytes(pdf)
    (d / "png-as.pdf").write_bytes(png)
    (d / "html-as.png").write_bytes(b"<html><script>alert(1)</script></html>")
    (d / "svg-as.pdf").write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    (d / "late-magic.pdf").write_bytes(b"<script>alert(1)</script>%PDF-1.4")
    (d / "empty.pdf").write_bytes(b"")
    c = make_client(example_root)

    r = c.get(ATT + "pdf-as.png")
    assert r.headers["content-type"] == "application/pdf" and r.headers["content-disposition"].startswith("inline")
    r = c.get(ATT + "png-as.pdf")
    assert r.headers["content-type"] == "image/png" and "sandbox" in r.headers["content-security-policy"]
    for name in ["html-as.png", "svg-as.pdf", "late-magic.pdf", "empty.pdf"]:
        r = c.get(ATT + name)
        assert r.status_code == 200, name
        assert r.headers["content-type"] == "application/octet-stream", name
        assert r.headers["content-disposition"].startswith("attachment"), name
        assert r.headers["content-security-policy"] == "default-src 'none'; sandbox", name
        assert r.headers["x-content-type-options"] == "nosniff", name


def test_unreadable_attachment_is_not_a_500(example_root: Path, make_client):
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    path = example_root / "House/Kitchen/Dishwasher/manual.pdf"
    path.chmod(0)
    try:
        c = TestClient(make_client(example_root).app, raise_server_exceptions=False)
        assert c.get(ATT + "manual.pdf").status_code in (403, 404)
    finally:
        path.chmod(0o644)


# --- HB-09: read_error ------------------------------------------------------------------------------------


def test_unreadable_folder_keeps_last_good_and_reports(root: Path, make_client):
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    vb.write_house(root, vb.house(placements=[{"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0}]))
    vb.item(root, "it_a", "name: A", rel="House/Sub/A.md")
    c = make_client(root)
    (root / "House/Sub").chmod(0o300)
    try:
        c.app.state.ctx.indexer.scan()
        it = c.get("/api/items/it_a").json()
        assert it["stale"] is True and it["name"] == "A"
        kinds = [(k, p) for k, p, _ in problems(c)]
        assert ("read_error", "House/Sub") in kinds and not any(k == "missing_note" for k, _ in kinds)
    finally:
        (root / "House/Sub").chmod(0o755)


# --- HB-11 -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [".", "./", "House/..", "..", " . "])
def test_notes_dir_root_forms_rejected(value: str):
    with pytest.raises(ConfigError):
        Settings.from_env({"HOUSEBOOK_NOTES_DIR": value})


def test_notes_dir_dot_folder_is_supported_or_rejected(root: Path):
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", "name: A", rel=".hb/A.md")
    env = {"HOUSEBOOK_NOTES_DIR": ".hb", "HOUSEBOOK_DATA_DIR": str(root), "HOUSEBOOK_CONTRACT_DIR": str(CONTRACT)}
    try:
        s = Settings.from_env({**env, "HOUSEBOOK_RESCAN_INTERVAL": "0"})
    except ConfigError:
        return
    with TestClient(create_app(s)) as c:
        assert c.get("/api/items").json()["count"] == 1


# --- spec gap: nested Keycloak groups ----------------------------------------------------------------------


@pytest.fixture
def proxy_client(example_root: Path, make_client):
    def factory(editor_group: str = "housebook-editors") -> TestClient:
        return make_client(
            example_root,
            client_host="10.0.0.5",
            auth_mode="proxy",
            trusted_proxies=(ipaddress.ip_network("10.0.0.5/32"),),
            editor_group=editor_group,
        )

    return factory


@pytest.mark.parametrize(
    "groups, role",
    [
        ("/housebook-editors-old", "viewer"),
        ("/x/housebook-editors-old", "viewer"),
        ("/housebook-editors/", "viewer"),
        ("/Housebook-Editors", "viewer"),
        ("/home/housebook-editors", "editor"),
        ("family, /home/housebook-editors", "editor"),
    ],
)
def test_editor_group_paths(proxy_client, groups: str, role: str):
    r = proxy_client().get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": groups})
    assert r.json()["role"] == role


def test_editor_group_configured_as_full_path(proxy_client):
    c = proxy_client("/home/housebook-editors")
    r = c.get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": "/home/housebook-editors"})
    assert r.json()["role"] == "editor"


# --- round 3: HB-12..HB-15 bypass probes --------------------------------------------------------------


@pytest.mark.parametrize("ae", ["*;q=0", "identity;q=0", "gzip;q=0.0", "gzip, gzip;q=0", "gzip;q=abc", "x-gzip", ""])
def test_gzip_refused_or_unknown_means_plain_and_strong(client: TestClient, ae: str):
    r = client.get("/api/snapshot", headers={"Accept-Encoding": ae})
    assert "content-encoding" not in r.headers and not r.headers["etag"].startswith("W/")
    assert "accept-encoding" in r.headers["vary"].lower()


@pytest.mark.parametrize("ae", ["gzip", "br;q=1, gzip;q=0.5", "gzip;q=0.001"])
def test_gzip_accepted_means_weak_etag_and_working_304(client: TestClient, ae: str):
    r = client.get("/api/snapshot", headers={"Accept-Encoding": ae})
    assert r.headers["content-encoding"] == "gzip" and r.headers["etag"].startswith("W/")
    weak = r.headers["etag"]
    for inm, enc in [(weak, ae), (weak.removeprefix("W/"), ae), (weak, "identity")]:
        nm = client.get("/api/snapshot", headers={"Accept-Encoding": enc, "If-None-Match": inm})
        assert nm.status_code == 304 and nm.content == b"" and "accept-encoding" in nm.headers["vary"].lower()


def test_file_backed_responses_never_compressed_and_keep_strong_etags(client: TestClient):
    gz = {"Accept-Encoding": "gzip"}
    for path in ["/api/house", "/api/items/it_7f3k2a", ATT + "manual.pdf", ATT + "receipt.png"]:
        r = client.get(path, headers=gz)
        assert "content-encoding" not in r.headers and not r.headers["etag"].startswith("W/"), path
    h = client.head("/api/house", headers=gz)
    assert h.headers["etag"] == client.get("/api/house").headers["etag"]


def test_attachment_unreadable_at_scan_is_read_error_and_unlisted(example_root: Path, make_client):
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    path = example_root / "House/Kitchen/Dishwasher/manual.pdf"
    c = make_client(example_root)
    path.chmod(0)
    try:
        assert c.get(ATT + "manual.pdf").status_code == 404  # before the rescan
        assert c.head(ATT + "manual.pdf", headers={"Range": "bytes=0-3"}).status_code == 404
        c.app.state.ctx.indexer.scan()
        assert ("read_error", "House/Kitchen/Dishwasher/manual.pdf") in [(k, p) for k, p, _ in problems(c)]
        assert "manual.pdf" not in [a["name"] for a in c.get("/api/items/it_7f3k2a").json()["attachments"]]
    finally:
        path.chmod(0o644)
    c.app.state.ctx.indexer.scan()
    assert c.get(ATT + "manual.pdf").status_code == 200 and c.get("/api/problems").json()["count"] == 0


@pytest.mark.parametrize(
    "groups, role",
    [
        ("/home/housebook-editors", "editor"),
        ("/home/housebook-editors/", "viewer"),
        ("home/housebook-editors", "viewer"),
        ("/x/home/housebook-editors", "viewer"),
        ("/home/housebook-editors-old", "viewer"),
        ("/other/housebook-editors", "viewer"),
        ("/kids, /home/housebook-editors", "editor"),
    ],
)
def test_editor_group_full_path_is_exact(proxy_client, groups: str, role: str):
    c = proxy_client("/home/housebook-editors")
    assert c.get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": groups}).json()["role"] == role


@pytest.mark.parametrize(
    "value, expected",
    [("./House", "House"), ("House/", "House"), ("House/.", "House"), ("a/./b", "a/b"), ("~House", "~House")],
)
def test_notes_dir_normalised(value: str, expected: str):
    assert Settings.from_env({"HOUSEBOOK_NOTES_DIR": value}).notes_dir == expected


@pytest.mark.parametrize("value", ["..", "./", ".hb", "House/.trash", "House~", "x.tmp", "House/4913", "a/../b"])
def test_notes_dir_ignored_or_escaping_names_rejected(value: str):
    with pytest.raises(ConfigError):
        Settings.from_env({"HOUSEBOOK_NOTES_DIR": value})


@pytest.mark.xfail(strict=True, reason="HB-16: SPA files send an ETag but never answer If-None-Match with 304")
def test_spa_index_revalidates(example_root: Path, make_client, tmp_path: Path):
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<!doctype html><title>Housebook</title>")
    c = make_client(example_root, static_dir=web)
    etag = c.get("/", headers={"Accept-Encoding": "identity"}).headers["etag"]
    assert c.get("/", headers={"Accept-Encoding": "identity", "If-None-Match": etag}).status_code == 304
