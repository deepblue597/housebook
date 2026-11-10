"""Write endpoints (milestone 4): PUT /api/house, item create/patch/delete/log/adopt."""

import copy
import json
import os
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import vault_builders as vb
from conftest import NOW, ClientFactory, load_fixture
from housebook.adapters.fs import HISTORY_KEEP, _history_key
from housebook.domain.frontmatter import parse
from housebook.services.indexer import content_hash

DISH = "it_7f3k2a"
DISH_PATH = "House/Kitchen/Dishwasher.md"


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def house_of(c: TestClient) -> tuple[dict, str]:
    r = c.get("/api/house")
    return r.json(), r.headers["etag"]


def put_house(c: TestClient, data: dict, etag: str | None = None, **headers: str) -> object:
    h = {"If-Match": etag} if etag else {}
    return c.put("/api/house", json=data, headers={**h, **headers})


def history(root: Path) -> list[str]:
    d = root / ".housebook" / "history"
    return sorted((p.name for p in d.iterdir()), key=lambda n: _history_key(n) or (n, 0)) if d.exists() else []


def stray_temp_files(root: Path) -> list[str]:
    return [str(p) for p in root.rglob(".*.tmp")]


# --- auth and request hygiene ------------------------------------------------------------------


def test_writes_need_the_editor_role(client: TestClient):  # default anon role: viewer
    data, etag = house_of(client)
    assert put_house(client, data, etag).status_code == 403
    assert client.post("/api/items", json={"type": "fridge"}).status_code == 403
    assert client.patch(f"/api/items/{DISH}", json={}, headers={"If-Match": "*"}).status_code == 403
    assert client.delete(f"/api/items/{DISH}", headers={"If-Match": "*"}).status_code == 403
    assert client.post(f"/api/items/{DISH}/log", json={"text": "x"}).status_code == 403


@pytest.mark.parametrize("ctype", [None, "text/plain", "application/x-www-form-urlencoded"])
def test_json_writes_require_a_json_content_type(editor: TestClient, ctype: str | None):
    """CSRF guard (DESIGN 15.13): a form or no-cors fetch can't send application/json."""
    data, etag = house_of(editor)
    headers = {"If-Match": etag} | ({"Content-Type": ctype} if ctype else {})
    r = editor.put("/api/house", content=json.dumps(data), headers=headers)
    assert r.status_code == 415
    r = editor.post(f"/api/items/{DISH}/log", content='{"text": "x"}', headers=headers)
    assert r.status_code == 415


def test_merge_patch_content_type_is_accepted(editor: TestClient):
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    r = editor.patch(
        f"/api/items/{DISH}",
        content='{"frontmatter": {"brand": "Siemens"}}',
        headers={"If-Match": etag, "Content-Type": "application/merge-patch+json"},
    )
    assert r.status_code == 200 and r.json()["fields"]["brand"] == "Siemens"


# --- PUT /api/house -----------------------------------------------------------------------------


def test_put_house_round_trip_is_byte_identical_no_op(editor: TestClient, example_root: Path):
    before = (example_root / "house.json").read_bytes()
    data, etag = house_of(editor)
    r = put_house(editor, data, etag)
    assert r.status_code == 200 and r.headers["etag"] == etag
    assert (example_root / "house.json").read_bytes() == before  # deterministic form = the committed file
    assert history(example_root) == []  # nothing written, nothing archived


def test_put_house_writes_validates_and_archives(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    data["rooms"][0]["name"] = "Lounge"
    data["floors"][0]["cells"] = dict(reversed(list(data["floors"][0]["cells"].items())))  # order must not matter
    r = put_house(editor, data, etag)
    assert r.status_code == 200, r.text
    new_etag = r.headers["etag"]
    raw = (example_root / "house.json").read_bytes()
    assert new_etag == f'"{content_hash(raw)}"' and new_etag != etag
    assert raw.endswith(b"}\n") and b'\n  "grid": {\n    "tileSize"' in raw  # 2-space indent, trailing newline
    keys = list(json.loads(raw)["floors"][0]["cells"])
    assert keys == sorted(keys, key=lambda k: (int(k.split(",")[1]), int(k.split(",")[0])))  # y then x
    assert json.loads(raw)["rooms"][0]["name"] == "Lounge" and r.json()["rooms"][0]["name"] == "Lounge"
    assert editor.get("/api/house").headers["etag"] == new_etag  # index updated synchronously
    assert editor.get("/api/snapshot").json()["houseEtag"] == new_etag.strip('"')
    (archived,) = history(example_root)
    assert archived.startswith("house-2026") and archived.endswith(".json")
    assert b'"Living room"' in (example_root / ".housebook" / "history" / archived).read_bytes()
    assert stray_temp_files(example_root) == []


def test_put_house_preconditions(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    r = put_house(editor, data)
    assert r.status_code == 428
    r = put_house(editor, data, '"0000"')
    assert r.status_code == 412 and r.json()["currentEtag"] == etag.strip('"') and r.headers["etag"] == etag
    assert put_house(editor, data, etag.strip('"')).status_code == 200  # unquoted, as the snapshot gives it
    assert put_house(editor, data, "W/" + etag).status_code == 200
    assert put_house(editor, data, '"zzz", ' + etag).status_code == 200
    assert put_house(editor, data, "*").status_code == 200
    assert put_house(editor, data, **{"If-None-Match": "*"}).status_code == 412  # exists already


def test_put_house_412_when_changed_on_disk_before_the_watcher_noticed(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    path = example_root / "house.json"
    path.write_text(path.read_text().replace("Living room", "Salon"))  # edited in VS Code; no rescan yet
    r = put_house(editor, data, etag)
    assert r.status_code == 412 and r.json()["currentEtag"] == content_hash(path.read_bytes())
    assert "Salon" in path.read_text()  # not overwritten
    assert editor.get("/api/house").headers["etag"] != etag  # 412 refreshed the index for the reload


def test_put_house_creates_a_missing_file_with_if_none_match(editor: TestClient, example_root: Path):
    data, _ = house_of(editor)
    (example_root / "house.json").unlink()
    editor.app.state.ctx.indexer.scan()
    assert put_house(editor, data, "*").status_code == 412
    assert put_house(editor, data).status_code == 428
    r = put_house(editor, data, **{"If-None-Match": "*"})
    assert r.status_code == 200 and (example_root / "house.json").exists()
    assert history(example_root) == []


@pytest.mark.parametrize("case", load_fixture("house_validation_cases.json")["cases"], ids=lambda c: c["id"])
def test_put_house_422_semantic_and_structural(editor: TestClient, example_root: Path, case: dict):
    before = (example_root / "house.json").read_bytes()
    data, etag = house_of(editor)
    house = copy.deepcopy(case["house"])
    r = put_house(editor, house, etag)
    assert r.status_code == 422, r.text
    got = [(e["type"], e["loc"]) for e in r.json()["detail"]]
    for want in case["errors"]:
        assert (want["type"], ["body", *want["loc"]]) in got, got
    assert all(isinstance(e["msg"], str) and e["msg"] for e in r.json()["detail"])
    assert (example_root / "house.json").read_bytes() == before


def test_put_house_reports_every_semantic_issue(editor: TestClient):
    data, etag = house_of(editor)
    data["rooms"].append(dict(data["rooms"][0]))
    data["placements"].append(dict(data["placements"][0]))
    data["floors"][0]["cells"]["99,0"] = "rm_gone"
    types = sorted(e["type"] for e in put_house(editor, data, etag).json()["detail"])
    assert types == [
        "house_duplicate_id",
        "house_duplicate_placement",
        "house_outside_grid",
        "house_unknown_room",
    ]


# --- D30: a save may not make the layout worse than the file on disk ------------------------------


def put_on(c: TestClient, root: Path, baseline: dict | None) -> str | None:
    """Put `baseline` on disk as the current house.json (None: no file) and return its ETag."""
    path = root / "house.json"
    if baseline is None:
        path.unlink(missing_ok=True)
    else:
        path.write_text(json.dumps(baseline, indent=2))
    c.app.state.ctx.indexer.scan()
    return None if baseline is None else c.get("/api/house").headers["etag"]


@pytest.mark.parametrize("case", load_fixture("house_validation_cases.json")["inherited"], ids=lambda c: c["id"])
def test_put_house_judged_against_the_file_on_disk(editor: TestClient, example_root: Path, case: dict):
    etag = put_on(editor, example_root, case["baseline"])
    before = (example_root / "house.json").read_bytes() if etag else None
    headers = {"If-Match": etag} if etag else {"If-None-Match": "*"}
    r = put_house(editor, copy.deepcopy(case["house"]), **headers)
    if not case["errors"]:
        assert r.status_code == 200, r.text
        return
    assert r.status_code == 422, r.text
    got = sorted((e["type"], e["loc"]) for e in r.json()["detail"])
    assert got == sorted((e["type"], ["body", *e["loc"]]) for e in case["errors"])  # only the offending ones
    after = (example_root / "house.json").read_bytes() if (example_root / "house.json").exists() else None
    assert after == before and history(example_root) == []


@pytest.fixture
def m5_03(example_root: Path, make_client: ClientFactory) -> TestClient:
    """The example home with a hand-edit leftover: a tile of a deleted room (M5-03)."""
    path = example_root / "house.json"
    data = json.loads(path.read_text())
    data["floors"][0]["cells"]["0,0"] = "rm_gone"
    path.write_text(json.dumps(data, indent=2))
    return make_client(example_root, anon_role="editor")


def test_inherited_unknown_room_does_not_block_saves(m5_03: TestClient, example_root: Path):
    assert "house_unknown_room" in {p["kind"] for p in m5_03.get("/api/problems").json()["problems"]}
    data, etag = house_of(m5_03)
    data["rooms"][0]["name"] = "Lounge"
    r = put_house(m5_03, data, etag)
    assert r.status_code == 200, r.text
    assert json.loads((example_root / "house.json").read_text())["floors"][0]["cells"]["0,0"] == "rm_gone"
    data, etag = house_of(m5_03)
    del data["floors"][0]["cells"]["0,0"]  # the repair ("Erase tiles") is just another save
    assert put_house(m5_03, data, etag).status_code == 200


@pytest.mark.parametrize(
    "cell, room",
    [("0,0", "rm_other"), ("15,0", "rm_gone")],
    ids=["other-missing-room", "one-more-tile-of-the-same-room"],
)
def test_new_unknown_room_tiles_are_still_rejected(m5_03: TestClient, example_root: Path, cell: str, room: str):
    before = (example_root / "house.json").read_bytes()
    data, etag = house_of(m5_03)
    data["floors"][0]["cells"][cell] = room
    r = put_house(m5_03, data, etag)
    assert r.status_code == 422, r.text
    assert {e["type"] for e in r.json()["detail"]} == {"house_unknown_room"}
    assert ["body", "floors", 0, "cells", cell] in [e["loc"] for e in r.json()["detail"]]
    assert (example_root / "house.json").read_bytes() == before


def test_bad_cell_key_is_always_rejected(m5_03: TestClient):
    data, etag = house_of(m5_03)
    data["floors"][0]["cells"]["01,0"] = data["floors"][0]["cells"].pop("1,0", "rm_gone")
    r = put_house(m5_03, data, etag)
    assert r.status_code == 422 and [e["type"] for e in r.json()["detail"]] == ["house_bad_cell"]


def test_if_match_star_is_judged_against_the_file_on_disk(m5_03: TestClient):
    data, _ = house_of(m5_03)
    data["grid"]["width"] = 17
    assert put_house(m5_03, data, "*").status_code == 200  # the inherited tile may stay
    data["floors"][0]["cells"]["16,0"] = "rm_gone"
    assert put_house(m5_03, data, "*").status_code == 422  # one more is worse, even with `*`


def test_create_with_if_none_match_is_fully_validated(m5_03: TestClient, example_root: Path):
    data, _ = house_of(m5_03)  # carries the rm_gone tile
    put_on(m5_03, example_root, None)
    r = put_house(m5_03, data, **{"If-None-Match": "*"})
    assert r.status_code == 422 and [e["type"] for e in r.json()["detail"]] == ["house_unknown_room"]
    assert not (example_root / "house.json").exists()
    data["floors"][0]["cells"]["0,0"] = data["rooms"][0]["id"]
    assert put_house(m5_03, data, **{"If-None-Match": "*"}).status_code == 200


def test_preconditions_and_read_only_come_before_the_semantic_422(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    data["floors"][0]["cells"]["0,0"] = "rm_gone"  # a new semantic issue
    assert put_house(editor, data).status_code == 428
    assert put_house(editor, data, '"0000"').status_code == 412
    assert put_house(editor, data, etag).status_code == 422
    data["placements"][0]["rotation"] = 45  # structure is checked before anything else
    assert put_house(editor, data).status_code == 422
    del data["placements"][0]["rotation"]
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 2', '"schemaVersion": 3'))
    editor.app.state.ctx.indexer.scan()
    r = put_house(editor, data, "*")
    assert r.status_code == 409 and r.json()["reason"] == "newer_version"


def test_put_house_412_when_the_file_is_replaced_during_the_rescan(
    editor: TestClient, example_root: Path, monkeypatch: pytest.MonkeyPatch
):
    """The ETag matched the file read first; the index lagged, and the rescan read a different
    file. Its read-only verdict and D30 baseline don't belong to what the client matched."""
    data, _ = house_of(editor)
    path = example_root / "house.json"
    matched = path.read_text().replace("Living room", "Salon")
    path.write_text(matched)  # changed on disk; the watcher hasn't noticed, the index lags
    indexer = editor.app.state.ctx.indexer
    scan = indexer.scan
    swapped = matched.replace("Salon", "Parlour")

    def replaced_then_scan():
        if path.read_text() == matched:
            path.write_text(swapped)  # another writer replaces the file between read and rescan
        return scan()

    monkeypatch.setattr(indexer, "scan", replaced_then_scan)
    r = put_house(editor, data, f'"{content_hash(matched.encode())}"')
    assert r.status_code == 412, r.text
    assert r.json()["currentEtag"] == content_hash(swapped.encode())
    assert path.read_text() == swapped and history(example_root) == []


def test_unreadable_house_json_is_409_before_the_preconditions(editor: TestClient, example_root: Path):
    if os.geteuid() == 0:
        pytest.skip("root can read a chmod 000 file")
    data, _ = house_of(editor)
    path = example_root / "house.json"
    path.chmod(0)
    try:
        r = put_house(editor, data)  # no If-Match: still 409, the file can't be judged at all
        assert r.status_code == 409 and r.json()["reason"] == "unreadable"
    finally:
        path.chmod(0o644)


def test_put_house_bad_json_and_size(editor: TestClient):
    _, etag = house_of(editor)
    r = editor.put("/api/house", content=b"{nope", headers={"If-Match": etag, "Content-Type": "application/json"})
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "json_invalid"
    big = b'{"x": "' + b"a" * (16 * 1024 * 1024) + b'"}'
    r = editor.put("/api/house", content=big, headers={"If-Match": etag, "Content-Type": "application/json"})
    assert r.status_code == 413


def test_newer_schema_version_is_never_written(example_root: Path, make_client: ClientFactory):
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 2', '"schemaVersion": 3, "newThing": []'))
    before = path.read_bytes()
    c = make_client(example_root, anon_role="editor")
    r = c.get("/api/house")
    data, etag = r.json(), r.headers["etag"]
    data["schemaVersion"] = 1
    for if_match in (etag, "*"):
        r = put_house(c, data, if_match)
        assert r.status_code == 409 and r.json()["reason"] == "newer_version"
    assert path.read_bytes() == before and history(example_root) == []


def test_invalid_house_json_is_read_only(example_root: Path, make_client: ClientFactory):
    (example_root / "house.json").write_text('{"schemaVersion": 1, "grid": "broken"}')
    c = make_client(example_root, anon_role="editor")
    r = put_house(c, vb.house(), "*")
    assert r.status_code == 409 and r.json()["reason"] == "invalid"


def test_put_keeps_dollar_schema_when_the_client_drops_it(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    del data["$schema"]
    data["grid"]["width"] = 17
    assert put_house(editor, data, etag).status_code == 200
    assert json.loads((example_root / "house.json").read_text())["$schema"] == "../../contract/house.schema.json"


def test_history_keeps_the_last_50(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    for i in range(HISTORY_KEEP + 5):
        data["rooms"][0]["name"] = f"Room {i}"
        r = put_house(editor, data, etag)
        assert r.status_code == 200
        etag = r.headers["etag"]
    files = history(example_root)
    assert len(files) == HISTORY_KEEP and len(set(files)) == HISTORY_KEEP
    newest = json.loads((example_root / ".housebook" / "history" / files[-1]).read_text())
    assert newest["rooms"][0]["name"] == f"Room {HISTORY_KEEP + 3}"  # the version before the last PUT
    oldest = json.loads((example_root / ".housebook" / "history" / files[0]).read_text())
    assert oldest["rooms"][0]["name"] == "Room 4"


def test_atomic_write_keeps_permissions_and_symlinked_target(editor: TestClient, example_root: Path):
    path = example_root / "House" / "Kitchen" / "Fridge.md"
    path.chmod(0o664)
    fridge = next(i for i in editor.get("/api/items").json()["items"] if i["path"] == "House/Kitchen/Fridge.md")
    r = editor.patch(f"/api/items/{fridge['id']}", json={"frontmatter": {"brand": "LG"}}, headers={"If-Match": "*"})
    assert r.status_code == 200
    assert stat.S_IMODE(path.stat().st_mode) == 0o664 and stray_temp_files(example_root) == []

    real = example_root / "house.real.json"
    os.replace(example_root / "house.json", real)
    (example_root / "house.json").symlink_to("house.real.json")
    editor.app.state.ctx.indexer.scan()
    data, etag = house_of(editor)
    data["grid"]["width"] = 18
    assert put_house(editor, data, etag).status_code == 200
    assert (example_root / "house.json").is_symlink() and json.loads(real.read_text())["grid"]["width"] == 18


# --- PATCH /api/items/{id} --------------------------------------------------------------------------


def patch(c: TestClient, item_id: str, body: dict, etag: str | None) -> object:
    return c.patch(f"/api/items/{item_id}", json=body, headers={"If-Match": etag} if etag else {})


def test_patch_frontmatter_minimal_diff(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    before = path.read_text()
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    r = patch(editor, DISH, {"frontmatter": {"serial": "0123", "model": "no", "next_check": "2027-03-01"}}, etag)
    assert r.status_code == 200, r.text
    after = path.read_text()
    removed = [ln for ln in before.split("\n") if ln not in after.split("\n")]
    added = [ln for ln in after.split("\n") if ln not in before.split("\n")]
    assert removed == ["model: SMS4HVI33E", "serial: FD 0412 00123"]
    assert added == ['model: "no"', 'serial: "0123"', "next_check: 2027-03-01"]
    out = r.json()
    assert out["fields"]["serial"] == "0123" and out["fields"]["model"] == "no"  # YAML 1.1 traps avoided
    assert out["frontmatter"]["serial"] == "0123" and r.headers["etag"] == f'"{out["etag"]}"'
    assert out["etag"] == content_hash(path.read_bytes())
    assert out["status"]["check"]["date"] == "2027-03-01"
    assert out["body"] == parse(before.encode()).body


def test_patch_null_deletes_and_unknown_keys_survive(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    path.write_text(path.read_text().replace("tags: [housebook]", "tags: [housebook]\naliases: [Πλυντήριο]  # gr"))
    editor.app.state.ctx.indexer.scan()
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    r = patch(editor, DISH, {"frontmatter": {"manual": None, "warranty_until": None, "nope": None}}, etag)
    assert r.status_code == 200
    text = path.read_text()
    assert "manual:" not in text and "warranty_until" not in text and "aliases: [Πλυντήριο]  # gr" in text
    assert r.json()["fields"]["manual"] is None and r.json()["frontmatter"]["aliases"] == ["Πλυντήριο"]


def test_patch_body_only_when_present(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    fm = path.read_text().split("\n---\n")[0]
    r = patch(editor, DISH, {"body": "\n## Notes\nNew text.\n"}, etag)
    assert r.status_code == 200 and path.read_text() == fm + "\n---\n\n## Notes\nNew text.\n"
    etag = r.headers["etag"]
    r = patch(editor, DISH, {"frontmatter": {"brand": "Neff"}, "body": None}, etag)
    assert r.status_code == 200 and path.read_text().endswith("\n---\n\n## Notes\nNew text.\n")


def test_patch_preconditions(editor: TestClient, example_root: Path):
    assert patch(editor, DISH, {"frontmatter": {"brand": "x"}}, None).status_code == 428
    r = patch(editor, DISH, {"frontmatter": {"brand": "x"}}, '"stale"')
    assert r.status_code == 412 and r.json()["currentEtag"] == content_hash((example_root / DISH_PATH).read_bytes())
    assert patch(editor, "it_nope00", {"frontmatter": {"brand": "x"}}, "*").status_code == 404


def test_patch_412_after_an_obsidian_save_the_index_has_not_seen(editor: TestClient, example_root: Path):
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    path = example_root / DISH_PATH
    path.write_text(path.read_text().replace("Add salt", "Add more salt"))
    r = patch(editor, DISH, {"frontmatter": {"brand": "x"}}, etag)
    assert r.status_code == 412 and "Add more salt" in path.read_text() and "Bosch" in path.read_text()
    fresh = editor.get(f"/api/items/{DISH}")
    assert "more salt" in fresh.json()["body"]  # the 412 refreshed the index
    assert patch(editor, DISH, {"frontmatter": {"brand": "x"}}, fresh.headers["etag"]).status_code == 200


def test_patch_validation(editor: TestClient):
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    r = patch(editor, DISH, {"frontmatter": {"next_check": "soon", "manual": "javascript:alert(1)"}}, etag)
    assert r.status_code == 422
    assert sorted(e["loc"][-1] for e in r.json()["detail"]) == ["manual", "next_check"]
    r = patch(editor, DISH, {"frontmatter": {"housebook_id": "it_other"}}, etag)
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "read_only"
    assert patch(editor, DISH, {"frontmatter": {"housebook_id": DISH, "brand": "ok"}}, etag).status_code == 200
    assert patch(editor, DISH, {"bogus": 1}, "*").status_code == 422  # unknown top-level field


def test_patch_unparseable_note_is_409(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    path.write_text(path.read_text().replace("name: Dishwasher", "name: [unclosed"))
    editor.app.state.ctx.indexer.scan()
    item = editor.get(f"/api/items/{DISH}").json()
    assert item["stale"] is True
    r = patch(editor, DISH, {"frontmatter": {"brand": "x"}}, "*")
    assert r.status_code == 409 and r.json()["reason"] == "unparseable"
    r = editor.post(f"/api/items/{DISH}/log", json={"text": "x"})
    assert r.status_code == 409


def test_patch_keeps_crlf_and_bom(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes().replace(b"\n", b"\r\n"))
    editor.app.state.ctx.indexer.scan()
    r = patch(editor, DISH, {"frontmatter": {"brand": "Neff"}}, "*")
    assert r.status_code == 200
    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf---\r\n") and b"\r\nbrand: Neff\r\n" in raw
    assert raw.count(b"\n") == raw.count(b"\r\n")


# --- POST /api/items/{id}/log -----------------------------------------------------------------------


def test_log_append(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    r = editor.post(f"/api/items/{DISH}/log", json={"text": "Cleaned\nthe filter"})
    assert r.status_code == 200
    assert "- 2026-09-15 Technician replaced the drain pump (85 €)\n- 2026-11-04 Cleaned the filter\n\n## Notes" in (
        path.read_text()
    )
    assert r.json()["body"].count("2026-11-04") == 1  # today in Europe/Athens (NOW)
    r = editor.post(f"/api/items/{DISH}/log", json={"text": "Older visit", "date": "2025-01-02"})
    assert "- 2026-11-04 Cleaned the filter\n- 2025-01-02 Older visit\n" in path.read_text()
    assert editor.post(f"/api/items/{DISH}/log", json={"text": "   "}).status_code == 422
    assert editor.post(f"/api/items/{DISH}/log", json={"text": "x", "date": "soon"}).status_code == 422
    assert editor.post("/api/items/it_nope00/log", json={"text": "x"}).status_code == 404


def test_log_creates_the_heading(editor: TestClient, example_root: Path):
    vb.item(example_root, "it_nolog1", "name: No log", "\n## Notes\nSome text.\n", rel="House/NoLog.md")
    editor.app.state.ctx.indexer.scan()
    assert editor.post("/api/items/it_nolog1/log", json={"text": "First"}).status_code == 200
    text = (example_root / "House" / "NoLog.md").read_text()
    assert text.endswith("## Notes\nSome text.\n\n## Maintenance log\n- 2026-11-04 First\n")


def test_log_needs_no_if_match_and_merges_with_disk(editor: TestClient, example_root: Path):
    path = example_root / DISH_PATH
    path.write_text(path.read_text().replace("Add salt", "Add more salt"))  # unseen external edit
    assert editor.post(f"/api/items/{DISH}/log", json={"text": "x"}).status_code == 200
    assert "Add more salt" in path.read_text() and "- 2026-11-04 x" in path.read_text()


# --- POST /api/items ------------------------------------------------------------------------------------


def test_create_item(editor: TestClient, example_root: Path):
    r = editor.post(
        "/api/items",
        json={"type": "washing_machine", "name": "Washer 2", "roomId": "rm_kit", "frontmatter": {"serial": "0123"}},
    )
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["id"].startswith("it_") and len(out["id"]) == 9 and out["type"] == "washer"
    assert out["path"] == "House/Kitchen/Washer 2.md" and r.headers["location"] == f"/api/items/{out['id']}"
    assert out["location"] is None  # unplaced until the client PUTs the layout (D8)
    text = (example_root / out["path"]).read_text()
    assert text.startswith(f'---\nhousebook_id: {out["id"]}\ntype: washer\nname: Washer 2\nserial: "0123"\n')
    assert "tags: [housebook]\n---\n" in text and "## Maintenance log" in text
    assert r.headers["etag"] == f'"{out["etag"]}"' and editor.get(f"/api/items/{out['id']}").status_code == 200
    assert all(p["kind"] != "missing_note" for p in editor.get("/api/problems").json()["problems"])


def test_create_names_collisions_and_defaults(editor: TestClient, example_root: Path):
    paths = [editor.post("/api/items", json={"type": "fridge", "roomId": "rm_kit"}).json()["path"] for _ in range(2)]
    assert paths == ["House/Kitchen/Fridge-2.md", "House/Kitchen/Fridge-3.md"]  # Fridge.md exists
    r = editor.post("/api/items", json={"type": "dishwasher", "roomId": "rm_kit"})
    assert r.json()["path"] == "House/Kitchen/Dishwasher-2.md"  # Dishwasher.md + folder exist
    r = editor.post("/api/items", json={"type": "router", "name": "../../etc/Ψυγείο: big?"})
    assert r.status_code == 201 and r.json()["path"] == "House/etc Ψυγείο big.md"  # NFC, no separators
    assert r.json()["name"] == "../../etc/Ψυγείο: big?"


def test_create_validation(editor: TestClient):
    def errors(body: dict) -> list:
        r = editor.post("/api/items", json=body)
        assert r.status_code == 422, r.text
        return [e["loc"][-1] for e in r.json()["detail"]]

    assert errors({"type": "spaceship"}) == ["type"]
    assert errors({"type": "fridge", "roomId": "rm_gone"}) == ["roomId"]
    assert errors({"type": "fridge", "name": "  "}) == ["name"]
    assert errors({"type": "fridge", "frontmatter": {"housebook_id": "it_x"}}) == ["housebook_id"]
    assert errors({"type": "fridge", "frontmatter": {"purchased": "yesterday"}}) == ["purchased"]


# --- DELETE /api/items/{id} -----------------------------------------------------------------------------


def test_delete_moves_note_and_attachments_to_trash(editor: TestClient, example_root: Path):
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    assert editor.delete(f"/api/items/{DISH}").status_code == 428
    assert editor.delete(f"/api/items/{DISH}", headers={"If-Match": '"x"'}).status_code == 412
    assert editor.delete(f"/api/items/{DISH}", headers={"If-Match": etag}).status_code == 204
    assert not (example_root / DISH_PATH).exists() and not (example_root / "House/Kitchen/Dishwasher").exists()
    (entry,) = (example_root / ".housebook" / "trash").iterdir()
    assert entry.name.endswith(f"-{DISH}") and (entry / "Dishwasher.md").exists()
    assert (entry / "Dishwasher" / "manual.pdf").exists()
    assert editor.get(f"/api/items/{DISH}").status_code == 404
    # The placement is still in house.json (the client removes it first, D8): a missing note.
    problems = editor.get("/api/problems").json()["problems"]
    assert any(p["kind"] == "missing_note" and p["itemId"] == DISH for p in problems)


def test_delete_keeps_a_sibling_folder_that_holds_other_notes(editor: TestClient, example_root: Path):
    vb.item(example_root, "it_sub001", "name: Sub", rel="House/Kitchen/Dishwasher/Sub.md")
    editor.app.state.ctx.indexer.scan()
    assert editor.delete(f"/api/items/{DISH}", headers={"If-Match": "*"}).status_code == 204
    assert (example_root / "House/Kitchen/Dishwasher/Sub.md").exists()


def test_trash_older_than_90_days_is_purged_at_startup(example_root: Path, make_client: ClientFactory):
    trash = example_root / ".housebook" / "trash"
    (trash / "20260701T000000000Z-it_old").mkdir(parents=True)
    (trash / "20261101T000000000Z-it_new").mkdir(parents=True)
    (trash / "keep-me").mkdir()
    make_client(example_root)
    assert sorted(p.name for p in trash.iterdir()) == ["20261101T000000000Z-it_new", "keep-me"]


# --- POST /api/items/adopt -------------------------------------------------------------------------------


def test_adopt_writes_the_id_on_the_first_line(editor: TestClient, example_root: Path):
    vb.write(example_root, "House/Tagged.md", "---\r\ntags: [housebook]  # mine\r\ntype: router\r\n---\r\nBody\r\n")
    vb.write(example_root, "House/Untagged.md", "---\ntype: router\n---\n")
    editor.app.state.ctx.indexer.scan()
    assert any(p["kind"] == "not_adopted" for p in editor.get("/api/problems").json()["problems"])
    r = editor.post("/api/items/adopt", json={"path": "House/Tagged.md"})
    assert r.status_code == 200, r.text
    item_id = r.json()["id"]
    raw = (example_root / "House/Tagged.md").read_bytes()
    expected = f"---\r\nhousebook_id: {item_id}\r\ntags: [housebook]  # mine\r\ntype: router\r\n---\r\nBody\r\n"
    assert raw == expected.encode()
    assert all(p["kind"] != "not_adopted" for p in editor.get("/api/problems").json()["problems"])
    # Only paths of current `not_adopted` problems are adoptable.
    assert editor.post("/api/items/adopt", json={"path": "House/Tagged.md"}).status_code == 404
    assert editor.post("/api/items/adopt", json={"path": "House/Untagged.md"}).status_code == 404
    assert editor.post("/api/items/adopt", json={"path": "Other/x.md"}).status_code == 422
    assert editor.post("/api/items/adopt", json={"path": "House/../../x.md"}).status_code == 422
    assert editor.post("/api/items/adopt", json={"path": "House/Nope.md"}).status_code == 404


# --- the write log (DESIGN 15.14) ---------------------------------------------------------------------


def test_writes_are_logged(editor: TestClient, caplog: pytest.LogCaptureFixture):
    caplog.set_level("INFO", logger="housebook")
    editor.post(f"/api/items/{DISH}/log", json={"text": "x"})
    rec = next(r for r in caplog.records if r.getMessage() == "note written")
    assert rec.item_id == DISH and rec.path == DISH_PATH and rec.op == "log"  # type: ignore[attr-defined]


def test_clock_is_used_for_history_names(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    data["grid"]["width"] = 20
    put_house(editor, data, etag)
    assert history(example_root)[0].startswith("house-" + NOW.strftime("%Y%m%dT%H%M%S"))


@pytest.mark.parametrize("case", load_fixture("house_validation_cases.json")["valid"], ids=lambda c: c["id"])
def test_put_house_accepts_valid_edge_cases(editor: TestClient, case: dict):
    _, etag = house_of(editor)
    assert put_house(editor, case["house"], etag).status_code == 200


def test_concurrent_patches_with_the_same_etag_one_wins(editor: TestClient, example_root: Path):
    etag = editor.get(f"/api/items/{DISH}").headers["etag"]
    with ThreadPoolExecutor(4) as pool:
        codes = sorted(
            pool.map(lambda i: patch(editor, DISH, {"frontmatter": {"brand": f"B{i}"}}, etag).status_code, range(4))
        )
    assert codes == [200, 412, 412, 412]
    assert parse((example_root / DISH_PATH).read_bytes()).data["brand"].startswith("B")


def test_concurrent_log_appends_all_land(editor: TestClient, example_root: Path):
    with ThreadPoolExecutor(4) as pool:
        codes = list(
            pool.map(lambda i: editor.post(f"/api/items/{DISH}/log", json={"text": f"e{i}"}).status_code, range(8))
        )
    assert codes == [200] * 8
    text = (example_root / DISH_PATH).read_text()
    assert all(f"- 2026-11-04 e{i}\n" in text for i in range(8))


# --- verification follow-ups ------------------------------------------------------------------------


def test_adopt_nfd_file_by_its_nfc_path(editor: TestClient, example_root: Path):
    import unicodedata

    nfd = unicodedata.normalize("NFD", "House/Κουζίνα/Ψυγείο.md")
    vb.write(example_root, nfd, "---\ntags: housebook\n---\n")
    editor.app.state.ctx.indexer.scan()
    problem = next(p for p in editor.get("/api/problems").json()["problems"] if p["kind"] == "not_adopted")
    assert problem["path"] == "House/Κουζίνα/Ψυγείο.md"  # reported in NFC
    r = editor.post("/api/items/adopt", json={"path": problem["path"]})
    assert r.status_code == 200 and r.json()["path"] == "House/Κουζίνα/Ψυγείο.md"
    assert (example_root / nfd).read_text().startswith("---\nhousebook_id: it_")


def test_newer_version_survives_rescans(example_root: Path, make_client: ClientFactory):
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 2', '"schemaVersion": 3'))
    c = make_client(example_root, anon_role="editor")
    for _ in range(3):
        c.app.state.ctx.indexer.scan()
    kinds = [p["kind"] for p in c.get("/api/problems").json()["problems"]]
    assert "house_newer_version" in kinds and c.get("/api/house").headers["x-housebook-read-only"] == "true"


def test_create_rejects_control_characters_in_the_name(editor: TestClient):
    for name in ("a\x00b", "two\nlines", "tab\there"):
        r = editor.post("/api/items", json={"type": "fridge", "name": name})
        assert r.status_code == 422 and r.json()["detail"][0]["loc"] == ["body", "name"]


def test_if_none_match_follows_rfc_9110(editor: TestClient):
    data, etag = house_of(editor)
    assert put_house(editor, data, etag, **{"If-None-Match": '"something-else"'}).status_code == 200
    assert put_house(editor, data, etag, **{"If-None-Match": etag}).status_code == 412
    assert put_house(editor, data, **{"If-None-Match": '"something-else"'}).status_code == 200


def test_viewer_is_refused_before_the_body_is_read(client: TestClient):
    # 403 whatever the body (not 415/422); a huge declared length is never buffered.
    r = client.put("/api/house", content=b"not json", headers={"Content-Type": "text/plain"})
    assert r.status_code == 403
    r = client.post("/api/items", content=b"x" * 1024, headers={"Content-Length": str(150 * 1024 * 1024)})
    assert r.status_code == 403


def test_body_size_is_capped_before_parsing(editor: TestClient):
    # Content-Length over the cap is refused up front ...
    headers = {"Content-Type": "application/json", "Content-Length": str(26 << 20)}
    assert editor.post("/api/items", content=b"{}", headers=headers).status_code == 413

    # ... and a chunked body (no Content-Length) is cut off while streaming.
    def chunks():
        for _ in range(30):
            yield b"x" * (1 << 20)

    r = editor.post("/api/items", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and len(r.content) < 1000


def test_validation_errors_do_not_echo_large_inputs(editor: TestClient):
    r = editor.post("/api/items", json={"type": "x" * 100_000})
    assert r.status_code == 422 and len(r.content) < 2000
    r = editor.post("/api/items", json={"type": "x" * 100})
    assert r.json()["detail"][0]["input"] == "x" * 100  # small inputs still shown
