"""house.json v2: floor and wall finishes (milestone 9, D41)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import CONTRACT, ClientFactory
from housebook.domain.finishes import load_finishes


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def house_of(c: TestClient) -> tuple[dict, str]:
    r = c.get("/api/house")
    return r.json(), r.headers["etag"]


def problems(c: TestClient) -> list[tuple[str, str]]:
    return [(p["kind"], p["message"]) for p in c.get("/api/problems").json()["problems"]]


def test_the_catalogue_is_valid_and_keys_are_unique():
    f = load_finishes(CONTRACT / "finishes.json")
    keys = [x.key for x in (*f.floors, *f.wallpapers)]
    assert len(keys) == len(set(keys))
    assert {"oak", "tiles_white", "checker", "carpet"} <= f.floor_keys
    assert f.paints and f.exterior_default.startswith("#")


def test_a_v1_file_is_served_as_v2_and_written_as_v2_on_the_first_save(example_root: Path, make_client: ClientFactory):
    path = example_root / "house.json"
    path.write_text(path.read_text().replace('"schemaVersion": 2', '"schemaVersion": 1'))
    c = make_client(example_root, anon_role="editor")
    data, etag = house_of(c)
    assert data["schemaVersion"] == 2
    data["rooms"][0]["floor"] = "oak"
    assert c.put("/api/house", json=data, headers={"If-Match": etag}).status_code == 200
    written = json.loads(path.read_text())
    assert written["schemaVersion"] == 2 and written["rooms"][0]["floor"] == "oak"
    # The v1 file is kept in the history.
    (old,) = (example_root / ".housebook" / "history").iterdir()
    assert json.loads(old.read_text())["schemaVersion"] == 1


def test_a_v1_body_from_an_older_app_is_upgraded(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    data["schemaVersion"] = 1
    r = editor.put("/api/house", json=data, headers={"If-Match": etag})
    assert r.status_code == 200, r.text
    assert json.loads((example_root / "house.json").read_text())["schemaVersion"] == 2


def test_finishes_round_trip_and_unset_ones_are_left_out(editor: TestClient, example_root: Path):
    data, etag = house_of(editor)
    data["exteriorWallColor"] = "#E6E1D8"
    data["rooms"][0].update(floor="herringbone", walls="#B7C2A6")
    data["rooms"][1].update(walls="stripes")
    assert editor.put("/api/house", json=data, headers={"If-Match": etag}).status_code == 200
    written = json.loads((example_root / "house.json").read_text())
    assert written["exteriorWallColor"] == "#E6E1D8"
    assert (written["rooms"][0]["floor"], written["rooms"][0]["walls"]) == ("herringbone", "#B7C2A6")
    assert written["rooms"][1]["walls"] == "stripes" and "floor" not in written["rooms"][1]
    assert "floor" not in written["rooms"][2] and "walls" not in written["rooms"][2]


@pytest.mark.parametrize(
    ("where", "key", "value"),
    [
        ("room", "floor", "Oak"),
        ("room", "floor", "#123456"),  # a floor is a finish, not a colour
        ("room", "walls", "Red paint"),
        ("room", "walls", "#12345"),
        ("house", "exteriorWallColor", "white"),
        ("house", "exteriorWallColor", "stripes"),
    ],
)
def test_malformed_finishes_are_refused(editor: TestClient, where: str, key: str, value: str):
    data, etag = house_of(editor)
    target = data["rooms"][0] if where == "room" else data
    target[key] = value
    r = editor.put("/api/house", json=data, headers={"If-Match": etag})
    assert r.status_code == 422
    assert key in r.json()["detail"][0]["loc"]


def test_unknown_finish_names_are_warnings_not_errors(editor: TestClient):
    data, etag = house_of(editor)
    data["rooms"][0].update(floor="marble_from_the_future", walls="tartan")
    assert editor.put("/api/house", json=data, headers={"If-Match": etag}).status_code == 200
    found = [m for k, m in problems(editor) if k == "house_unknown_finish"]
    assert len(found) == 2
    assert any("marble_from_the_future" in m for m in found) and any("tartan" in m for m in found)


def test_every_finish_has_a_shipped_texture_and_a_real_size():
    textures = CONTRACT.parent / "apps" / "web" / "src" / "assets" / "textures"
    f = load_finishes(CONTRACT / "finishes.json")
    shipped = {p.name for p in textures.iterdir() if p.suffix == ".jpg"}
    used = set()
    for finish in (*f.floors, *f.wallpapers):
        assert finish.texture in shipped, finish.key
        assert finish.size and all(0.1 <= s <= 5 for s in finish.size), finish.key
        used.add(finish.texture)
    assert used == shipped  # no texture shipped that nothing uses
