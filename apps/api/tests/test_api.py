from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import nasty_vault
from conftest import ClientFactory


@pytest.fixture
def nasty(tmp_path: Path, make_client: ClientFactory) -> TestClient:
    root = tmp_path / "vault"
    nasty_vault.build(root, tmp_path / "outside")
    return make_client(root)


# --- health -----------------------------------------------------------------------------


def test_health(client: TestClient):
    assert client.get("/healthz").json() == {"status": "ok", "checks": {}}
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["checks"] == {"scanned": True, "dataWritable": True}


def test_readyz_fails_when_data_root_not_writable(example_root: Path, make_client: ClientFactory):
    example_root.chmod(0o555)
    try:
        r = make_client(example_root).get("/readyz")
        assert r.status_code == 503 and r.json()["checks"]["dataWritable"] is False
    finally:
        example_root.chmod(0o755)


# --- house + snapshot -------------------------------------------------------------------


def test_house_etag_and_304(client: TestClient):
    r = client.get("/api/house")
    assert r.status_code == 200
    etag = r.headers["etag"]
    body = r.json()
    assert body["schemaVersion"] == 1 and body["$schema"] == "../../contract/house.schema.json"
    assert len(body["openings"]) == 15 and "X-Housebook-Read-Only" not in r.headers
    r2 = client.get("/api/house", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.headers["etag"] == etag
    assert client.get("/api/house", headers={"If-None-Match": '"other"'}).status_code == 200


def test_house_newer_schema_is_read_only(example_root: Path, make_client: ClientFactory):
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 1', '"schemaVersion": 2, "newThing": []'))
    c = make_client(example_root)
    r = c.get("/api/house")
    assert r.status_code == 200 and r.headers["X-Housebook-Read-Only"] == "true"
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["houseSchemaVersion"] == 2
    assert any(p["kind"] == "house_newer_version" for p in c.get("/api/problems").json()["problems"])


def test_house_missing(example_root: Path, make_client: ClientFactory):
    (example_root / "house.json").unlink()
    c = make_client(example_root)
    assert c.get("/api/house").status_code == 404
    assert c.get("/api/snapshot").json()["house"] is None
    assert c.get("/api/problems").json()["problems"][0]["kind"] == "house_missing"


def test_snapshot(client: TestClient):
    r = client.get("/api/snapshot")
    assert r.status_code == 200
    snap = r.json()
    assert snap["today"] == "2026-11-04" and snap["timezone"] == "Europe/Athens"
    assert snap["problemCount"] == 0 and snap["houseReadOnly"] is False
    assert snap["house"]["grid"] == {"tileSize": 1.0, "width": 16, "depth": 10}
    assert len(snap["items"]) == 14
    dish = next(i for i in snap["items"] if i["id"] == "it_7f3k2a")
    assert dish["body"].startswith("\n## Quick help") and dish["errorCodes"] == ["E15"]  # body kept verbatim
    assert dish["location"] == {"floorId": "fl_0", "roomId": "rm_kit", "x": 10, "y": 2, "rotation": 90}

    etag = r.headers["etag"]
    assert client.get("/api/snapshot", headers={"If-None-Match": etag}).status_code == 304
    strong = etag.removeprefix("W/")  # weak when the client accepts gzip
    assert client.get("/api/snapshot", headers={"If-None-Match": f'W/{strong}, "x"'}).status_code == 304
    assert client.get("/api/snapshot", headers={"If-None-Match": strong}).status_code == 304


def test_snapshot_etag_changes_after_rescan_with_edit(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root)
    etag = c.get("/api/snapshot").headers["etag"]
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/snapshot").headers["etag"] == etag  # nothing changed
    note = example_root / "House/Kitchen/Oven.md"
    note.write_text(note.read_text().replace("Bosch", "Siemens"))
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/snapshot", headers={"If-None-Match": etag}).status_code == 200


# --- items ------------------------------------------------------------------------------


def test_item_detail(client: TestClient):
    r = client.get("/api/items/it_7f3k2a")
    assert r.status_code == 200
    item = r.json()
    assert r.headers["etag"] == f'"{item["etag"]}"'
    assert item["path"] == "House/Kitchen/Dishwasher.md"
    assert item["fields"]["serial"] == "FD 0412 00123" and item["fields"]["warranty_until"] == "2027-05-10"
    assert item["frontmatter"]["tags"] == ["housebook"]
    assert item["type"] == "dishwasher" and item["typeKnown"] and item["critical"] is False
    assert item["status"] == {
        "level": None,
        "check": None,
        "warranty": {"state": "active", "date": "2027-05-10", "days": 187},
    }
    assert [a["name"] for a in item["attachments"]] == ["manual.pdf", "receipt.png"]
    assert item["obsidianUrl"] is None and item["stale"] is False


def test_item_critical_from_catalog_and_obsidian_url(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, obsidian_vault="home page", obsidian_vault_subpath="Housebook")
    fuse = c.get("/api/items/it_7n3d8f").json()
    assert fuse["critical"] is True
    assert fuse["obsidianUrl"] == "obsidian://open?vault=home%20page&file=Housebook%2FHouse%2FHallway%2FFuse%20box.md"


def test_item_status_uses_check_every(client: TestClient):
    heater = client.get("/api/items/it_1w7e3h").json()
    assert heater["fields"]["check_every"] == "2y"
    assert heater["status"]["check"]["derived"] is False  # explicit next_check wins


def test_item_not_found(client: TestClient):
    assert client.get("/api/items/it_nope00").status_code == 404


def test_items_search_and_due(client: TestClient):
    names = lambda r: [i["name"] for i in r.json()["items"]]  # noqa: E731
    assert names(client.get("/api/items", params={"q": "e15"})) == ["Dishwasher"]
    assert names(client.get("/api/items", params={"q": "θερμοσιφωνας"})) == ["Water heater"]
    assert names(client.get("/api/items", params={"q": "kitchen bosch"})) == ["Dishwasher", "Oven"]
    due = client.get("/api/items", params={"due": 30}).json()
    assert [(i["name"], i["status"]["level"]) for i in due["items"]] == [
        ("Smoke detector", "overdue"),
        ("Living room AC", "due_soon"),
        ("Washing machine", "warranty_ending"),
    ]
    assert due["count"] == 3
    all_items = client.get("/api/items").json()
    assert all_items["count"] == 14 and "body" not in all_items["items"][0]
    assert client.get("/api/items", params={"due": -1}).status_code == 422


def test_problems_and_catalog(client: TestClient):
    assert client.get("/api/problems").json()["count"] == 0
    cat = client.get("/api/catalog").json()
    fridge = next(t for t in cat["types"] if t["key"] == "fridge")
    assert fridge == {
        "key": "fridge",
        "label": "Fridge",
        "defaultName": "Fridge",
        "footprint": [1, 1],
        "mount": "floor",
        "critical": False,
        "aliases": ["refrigerator", "freezer"],
    }


# --- attachments ------------------------------------------------------------------------


def test_attachment_pdf_inline_with_range(client: TestClient):
    url = "/api/items/it_7f3k2a/attachments/manual.pdf"
    r = client.get(url)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'inline; filename="manual.pdf"'
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"  # PDF.js renders in-app
    part = client.get(url, headers={"Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == b"%PDF"


def test_attachment_image_is_sandboxed(client: TestClient):
    r = client.get("/api/items/it_7f3k2a/attachments/receipt.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"


def test_attachment_html_is_a_sandboxed_download(nasty: TestClient):
    r = nasty.get("/api/items/it_dish00/attachments/page.html")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment;")
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"


def test_attachment_nfd_name(nasty: TestClient):
    item = nasty.get("/api/items/it_greek").json()
    url = item["attachments"][0]["url"]
    assert url == "/api/items/it_greek/attachments/%CE%B5%CE%B3%CF%87%CE%B5%CE%B9%CF%81%CE%AF%CE%B4%CE%B9%CE%BF.pdf"
    r = nasty.get(url)
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert "filename*=utf-8''" in r.headers["content-disposition"]


@pytest.mark.parametrize(
    "name, status",
    [
        ("evil.pdf", 404),  # symlink to outside the root: never indexed
        (".hidden.pdf", 400),
        ("%2E%2E", 400),  # a literal ".." is normalised away by the HTTP client
        ("notes.md", 404),
        ("missing.pdf", 404),
        ("manual.pdf%00.png", 400),
        ("..%2F..%2F..%2Fhouse.json", 404),
        ("..%5C..%5Chouse.json", 400),
    ],
)
def test_attachment_path_safety(nasty: TestClient, name: str, status: int):
    assert nasty.get(f"/api/items/it_dish00/attachments/{name}").status_code == status


def test_attachment_symlink_swapped_after_scan_is_rejected(nasty: TestClient, tmp_path: Path):
    # The index saw a regular file; replacing it with a symlink out of the root must not leak.
    target = tmp_path / "vault/House/Kitchen/Dishwasher/photo.png"
    target.unlink()
    target.symlink_to(tmp_path / "outside/evil.pdf")
    assert nasty.get("/api/items/it_dish00/attachments/photo.png").status_code == 404


def test_attachment_of_unknown_item(client: TestClient):
    assert client.get("/api/items/it_nope00/attachments/manual.pdf").status_code == 404


# --- nasty vault through the API --------------------------------------------------------


def test_nasty_vault_api(nasty: TestClient):
    snap = nasty.get("/api/snapshot").json()
    assert len(snap["items"]) == 13
    serial = nasty.get("/api/items/it_serial").json()
    assert serial["fields"]["serial"] == "0123" and serial["fields"]["model"] == "no"
    problems = nasty.get("/api/problems").json()
    assert problems["count"] == snap["problemCount"] > 0
    assert problems["problems"][0]["severity"] == "error"
    assert {"kind", "severity", "message", "path", "itemId", "detail"} <= set(problems["problems"][0])
    assert nasty.get("/api/items/it_unkn01").json()["typeKnown"] is False


def test_stale_item_is_served_with_flag(tmp_path: Path, make_client: ClientFactory):
    root = tmp_path / "vault"
    nasty_vault.build(root, tmp_path / "outside")
    c = make_client(root)
    (root / "House/Kitchen/CRLF.md").write_text("---\nbroken: [", encoding="utf-8")
    c.app.state.ctx.indexer.scan()
    item = c.get("/api/items/it_crlf0").json()
    assert item["stale"] is True and item["fields"]["name"] == "CRLF note" and item["parseError"]


# --- auth -------------------------------------------------------------------------------


def test_auth_none_defaults_to_viewer(client: TestClient):
    assert client.get("/api/me").json() == {"user": None, "role": "viewer", "authMode": "none"}


def test_auth_none_editor_when_explicit(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, anon_role="editor")
    assert c.get("/api/me").json()["role"] == "editor"


@pytest.fixture
def proxied(example_root: Path, make_client: ClientFactory):
    import ipaddress

    def factory(client_host: str) -> TestClient:
        return make_client(
            example_root,
            client_host=client_host,
            auth_mode="proxy",
            trusted_proxies=(ipaddress.ip_network("10.0.0.0/24"),),
        )

    return factory


def test_auth_proxy_roles(proxied):
    c = proxied("10.0.0.7")
    me = c.get("/api/me", headers={"X-Forwarded-User": "iasonas", "X-Forwarded-Groups": "/family,/housebook-editors"})
    assert me.json() == {"user": "iasonas", "role": "editor", "authMode": "proxy"}
    me = c.get("/api/me", headers={"X-Forwarded-User": "kid", "X-Forwarded-Groups": "family"})
    assert me.json()["role"] == "viewer"
    assert c.get("/api/me").status_code == 401  # no user header


def test_auth_proxy_ignores_untrusted_peers(proxied):
    c = proxied("192.168.1.50")
    headers = {"X-Forwarded-User": "mallory", "X-Forwarded-Groups": "housebook-editors"}
    assert c.get("/api/me", headers=headers).status_code == 401
    assert c.get("/api/snapshot", headers=headers).status_code == 401
    assert c.get("/healthz").status_code == 200 and c.get("/readyz").status_code == 200


# --- SPA --------------------------------------------------------------------------------


@pytest.fixture
def spa_dir(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Housebook</title>")
    (web / "sw.js").write_text("// sw")
    (web / "assets" / "index-B4x9KqZ1.js").write_text("console.log(1)")
    (web / "manifest.webmanifest").write_text("{}")
    return web


def test_spa_fallback_and_caching(example_root: Path, make_client: ClientFactory, spa_dir: Path):
    c = make_client(example_root, static_dir=spa_dir)
    r = c.get("/")
    assert r.status_code == 200 and "Housebook" in r.text and r.headers["cache-control"] == "no-cache"
    r = c.get("/i/it_7f3k2a")  # client-side route (QR deep link)
    assert "Housebook" in r.text and r.headers["cache-control"] == "no-cache"
    r = c.get("/assets/index-B4x9KqZ1.js")
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert c.get("/sw.js").headers["cache-control"] == "no-cache"
    assert c.get("/manifest.webmanifest").headers["cache-control"] == "no-cache"
    assert c.get("/assets/index-Missing1.js").status_code == 404
    assert c.get("/api/unknown").status_code == 404
    assert c.get("/../../etc/passwd").status_code in (200, 404)  # normalised by the client; never a file leak
    assert "root:" not in c.get("/..%2F..%2Fetc%2Fpasswd").text


def test_no_spa_built(client: TestClient):
    assert client.get("/").json()["web"] == "not built"
    assert client.get("/i/it_7f3k2a").status_code == 404


def test_openapi_is_served(client: TestClient):
    spec = client.get("/api/openapi.json").json()
    assert "/api/snapshot" in spec["paths"] and "/api/items/{item_id}/attachments/{name}" in spec["paths"]


def test_single_process_lock(example_root: Path, make_client: ClientFactory):
    from housebook.lock import LockHeld

    make_client(example_root)
    with pytest.raises(LockHeld):
        make_client(example_root)
