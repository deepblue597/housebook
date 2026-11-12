"""Independent verification of milestone 4 (backend). Each test asserts the SPEC'd behaviour;
a failing test is a finding (see the verification report)."""

import json
import unicodedata
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import ClientFactory

# Each test reproduced a finding; all are fixed, so the module-level strict xfail is gone.

DISHWASHER = "it_7f3k2a"


def etag(c: TestClient, item_id: str) -> str:
    return c.get(f"/api/items/{item_id}").headers["etag"]


def test_newer_version_problem_survives_a_second_scan(example_root: Path, make_client: ClientFactory):
    """contract §2.3/§7.1: a newer schemaVersion is read-only WITH a house_newer_version problem,
    and PUT is 409 reason newer_version. The indexer's unchanged-file shortcut drops the problem
    on every scan after the first (any write or rescan), so PUT then says reason=invalid."""
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 2', '"schemaVersion": 3'))
    c = make_client(example_root, anon_role="editor")
    kinds = [p["kind"] for p in c.get("/api/problems").json()["problems"]]
    assert "house_newer_version" in kinds
    # any note write rescans
    r = c.post(f"/api/items/{DISHWASHER}/log", json={"text": "x"})
    assert r.status_code == 200
    kinds = [p["kind"] for p in c.get("/api/problems").json()["problems"]]
    assert "house_newer_version" in kinds, kinds
    data = c.get("/api/house").json()
    r = c.put("/api/house", json=data, headers={"If-Match": "*"})
    assert r.status_code == 409 and r.json()["reason"] == "newer_version", r.json()


def test_patch_oversized_note_is_413(example_root: Path, make_client: ClientFactory):
    """contract §8: 413 when a note would exceed 4 MiB."""
    c = make_client(example_root, anon_role="editor")
    body = "α" * (2 * 1024 * 1024 + 100)  # < 4 Mi characters, > 4 MiB of UTF-8
    r = c.patch(f"/api/items/{DISHWASHER}", json={"body": body}, headers={"If-Match": etag(c, DISHWASHER)})
    assert r.status_code == 413, (r.status_code, str(r.json())[:200])


def test_patch_body_over_max_length_is_413_not_echoed(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, anon_role="editor")
    body = "a" * (4 * 1024 * 1024 + 1)
    r = c.patch(f"/api/items/{DISHWASHER}", json={"body": body}, headers={"If-Match": etag(c, DISHWASHER)})
    assert r.status_code == 413, r.status_code
    assert len(r.content) < 10_000, f"error echoes the input: {len(r.content)} bytes"


def test_adopt_refuses_notes_the_scanner_ignores(example_root: Path, make_client: ClientFactory):
    """Adopt is for `not_adopted` notes; a note in a hidden folder is never indexed and must not
    be written."""
    hidden = example_root / "House" / ".hidden" / "x.md"
    hidden.parent.mkdir()
    hidden.write_text("---\ntype: tv\ntags: [housebook]\n---\n")
    before = hidden.read_bytes()
    c = make_client(example_root, anon_role="editor")
    r = c.post("/api/items/adopt", json={"path": "House/.hidden/x.md"})
    assert hidden.read_bytes() == before, f"ignored note was rewritten; response {r.status_code}"
    assert r.status_code in (404, 422)


def test_create_never_produces_a_conflict_copy_name(example_root: Path, make_client: ClientFactory):
    """contract §3.6: new file names are never an ignored pattern; a name that matches a sync
    conflict pattern makes the brand-new item a `conflict_copy` problem."""
    c = make_client(example_root, anon_role="editor")
    for name in ("Fridge.sync-conflict-20240101-000000-ABCDEFG", "Fridge (conflicted copy 2024-01-01)"):
        r = c.post("/api/items", json={"type": "fridge", "name": name})
        assert r.status_code == 201
        item_id = r.json()["id"]
        kinds = [p["kind"] for p in c.get("/api/problems").json()["problems"] if p.get("itemId") == item_id]
        assert kinds == [], (name, r.json()["path"], kinds)


def test_create_reuses_an_existing_nfd_room_folder(example_root: Path, make_client: ClientFactory):
    """DESIGN 15.3: macOS/iOS sync NFD names. A room folder already on disk in NFD must be reused,
    not shadowed by a second, visually identical NFC folder."""
    house = json.loads((example_root / "house.json").read_text())
    house["rooms"][1]["name"] = "Κουζίνα"  # rm_kit
    (example_root / "house.json").write_text(json.dumps(house))
    nfd = unicodedata.normalize("NFD", "Κουζίνα")
    (example_root / "House" / nfd).mkdir()
    c = make_client(example_root, anon_role="editor")
    r = c.post("/api/items", json={"type": "oven", "name": "Φούρνος", "roomId": "rm_kit"})
    assert r.status_code == 201
    folders = [p.name for p in (example_root / "House").iterdir() if unicodedata.normalize("NFC", p.name) == "Κουζίνα"]
    assert len(folders) == 1, folders
