"""D30 edge cases beyond the contract fixtures: ways a save could sneak a worse layout past the
per-subject counting, layout-wide transforms with inherited problems, and side effects of a 422."""

import copy
import json
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_events import frames
from test_writes import history, house_of, put_house

from conftest import EXAMPLES, ClientFactory
from housebook.services.indexer import content_hash

Mutation = Callable[[dict], object]
N_OPENINGS = len(json.loads((EXAMPLES / "house.json").read_text())["openings"])  # index of an appended one


def cells(d: dict, floor: int = 0) -> dict:
    return d["floors"][floor]["cells"]


def door(floor: str, x: int, y: int) -> dict:
    return {"floorId": floor, "x": x, "y": y, "side": "n", "kind": "door"}


# One hand-edit leftover of every kind the counting tolerates (house_bad_cell is never inherited:
# the server normalises it when reading).
INHERITED: dict[str, Mutation] = {
    "unknown_room": lambda d: cells(d).update({"0,0": "rm_gone"}),
    "duplicate_placement": lambda d: d["placements"].append(dict(d["placements"][0], x=0, y=0)),
    "placement_outside": lambda d: d["placements"][0].update(x=15, footprint=[3, 1]),
    "placement_unknown_floor": lambda d: d["placements"][1].update(floorId="fl_nope"),
    "cell_outside": lambda d: cells(d).update({"16,0": "rm_kit", "20,20": "rm_kit"}),
    "opening_outside": lambda d: d["openings"].append(door("fl_0", 30, 0)),
    "opening_unknown_floor": lambda d: d["openings"].append(door("fl_nope", 1, 1)),
    "duplicate_room_id": lambda d: d["rooms"].append(dict(d["rooms"][0], name="Dup")),
    "duplicate_floor_id": lambda d: d["floors"].append({"id": "fl_b1", "name": "Again", "level": 3}),
}


def all_inherited(d: dict) -> None:
    for f in INHERITED.values():
        f(d)


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def on_disk(c: TestClient, root: Path, mutate: Mutation) -> tuple[dict, str]:
    """Write the example house with `mutate` applied as house.json; return it and its ETag."""
    data, _ = house_of(c)
    mutate(data)
    (root / "house.json").write_text(json.dumps(data, indent=2))
    c.app.state.ctx.indexer.scan()
    got, etag = house_of(c)
    return got, etag


def changed(base: dict, *mutations: Mutation) -> dict:
    d = copy.deepcopy(base)
    for m in mutations:
        m(d)
    return d


def shift(dx: int, dy: int) -> Mutation:
    """Grow the grid north/west: every coordinate moves by (dx, dy)."""

    def f(d: dict) -> None:
        d["grid"]["width"] += dx
        d["grid"]["depth"] += dy
        for fl in d["floors"]:
            xy = {k: tuple(map(int, k.split(","))) for k in fl["cells"]}
            fl["cells"] = {f"{xy[k][0] + dx},{xy[k][1] + dy}": v for k, v in fl["cells"].items()}
        for o in (*d["placements"], *d["openings"]):
            o["x"] += dx
            o["y"] += dy

    return f


def shrink_east(w: int) -> Mutation:
    """What the editor's resize does: cut the columns that leave the grid (and only those)."""

    def f(d: dict) -> None:
        old = d["grid"]["width"]
        d["grid"]["width"] = w
        for fl in d["floors"]:
            fl["cells"] = {k: v for k, v in fl["cells"].items() if not w <= int(k.split(",")[0]) < old}
        d["placements"] = [p for p in d["placements"] if not w <= p["x"] < old]
        d["openings"] = [
            o for o in d["openings"] if not ((w <= o["x"] < old) if o["side"] == "n" else (w < o["x"] <= old))
        ]

    return f


# --- inherited problems never block, whatever the save does to positions and order ---------------


@pytest.mark.parametrize(
    "edit",
    [
        lambda d: d["rooms"][0].update(name="Lounge"),
        shift(0, 2),
        shift(3, 0),
        lambda d: d["grid"].update(width=20, depth=14),
        shrink_east(12),
        lambda d: [d[k].reverse() for k in ("rooms", "floors", "placements", "openings")],
        lambda d: [d["placements"][0].update(x=50), d["placements"][-1].update(x=5, y=5)],
    ],
    ids=["rename", "grow-north", "grow-west", "grow-east-south", "shrink-east-cut", "reorder", "move-copies"],
)
def test_every_inherited_kind_survives_editor_operations(editor: TestClient, example_root: Path, edit: Mutation):
    base, etag = on_disk(editor, example_root, all_inherited)
    r = put_house(editor, changed(base, edit), etag)
    assert r.status_code == 200, r.text


# --- ways to sneak a worse layout past the counting ------------------------------------------------


@pytest.mark.parametrize(
    "inherited, edit, errors",
    [
        pytest.param(
            "unknown_room",
            lambda d: cells(d, 1).update({"0,0": "rm_gone"}),
            [("house_unknown_room", ["floors", 1, "cells", "0,0"])],
            id="same-missing-room-on-another-floor",
        ),
        pytest.param(
            "unknown_room",
            lambda d: [cells(d).pop("0,0"), cells(d, 1).update({"9,9": "rm_gone"})],
            [("house_unknown_room", ["floors", 1, "cells", "9,9"])],
            id="inherited-tile-moved-to-another-floor",
        ),
        pytest.param(
            "placement_outside",
            lambda d: d["placements"][0].update(x=0, footprint=None, floorId="fl_nope"),
            [("house_unknown_floor", ["placements", 0, "floorId"])],
            id="swap-kind-outside-to-unknown-floor",
        ),
        pytest.param(
            "cell_outside",
            lambda d: [cells(d).pop("16,0"), d["openings"].append(door("fl_0", 30, 0))],
            [("house_outside_grid", ["openings", N_OPENINGS])],
            id="trade-a-cell-outside-for-an-opening-outside",
        ),
        pytest.param(
            "opening_unknown_floor",  # opening on unknown floor 'fl_nope'
            lambda d: d["placements"].append({"itemId": "fl_nope", "floorId": "fl_nope", "x": 0, "y": 0}),
            [("house_unknown_floor", ["placements", 14, "floorId"])],
            id="item-id-equal-to-an-inherited-unknown-floor-id",
        ),
        pytest.param(
            "duplicate_placement",
            lambda d: [d["placements"].pop(), d["placements"].append(dict(d["placements"][1]))],
            [("house_duplicate_placement", ["placements", 14, "itemId"])],
            id="un-duplicate-one-item-duplicate-another",
        ),
        pytest.param(
            "duplicate_room_id",
            lambda d: d["rooms"].append(dict(d["rooms"][1])),
            [("house_duplicate_id", ["rooms", 10, "id"])],
            id="duplicate-another-room-id",
        ),
        pytest.param(
            "placement_unknown_floor",
            lambda d: d["openings"].append(door("fl_nope", 0, 0)),
            [("house_unknown_floor", ["openings", N_OPENINGS, "floorId"])],
            id="opening-on-the-unknown-floor-of-an-inherited-placement",
        ),
    ],
)
def test_sneaks_are_rejected(editor: TestClient, example_root: Path, inherited: str, edit: Mutation, errors: list):
    base, etag = on_disk(editor, example_root, INHERITED[inherited])
    before = (example_root / "house.json").read_bytes()
    r = put_house(editor, changed(base, edit), etag)
    assert r.status_code == 422, r.text
    assert sorted((e["type"], e["loc"]) for e in r.json()["detail"]) == sorted((t, ["body", *loc]) for t, loc in errors)
    assert (example_root / "house.json").read_bytes() == before and history(example_root) == []


def test_trading_inherited_issues_of_one_subject_is_allowed(editor: TestClient, example_root: Path):
    """D30 counts per (code, subject), not per position: dropping the inherited outside tiles and
    adding as many elsewhere (even of another room) on the same floor is not "worse". By design."""
    base, etag = on_disk(editor, example_root, INHERITED["cell_outside"])
    trade = changed(base, lambda d: [cells(d).pop("16,0"), cells(d).pop("20,20")])
    trade = changed(trade, lambda d: cells(d).update({"100,100": "rm_kit", "99,0": "rm_bed"}))
    assert put_house(editor, trade, etag).status_code == 200


def test_naive_shrink_lists_inherited_issues_of_the_worsened_subject(editor: TestClient, example_root: Path):
    base, etag = on_disk(editor, example_root, all_inherited)
    r = put_house(editor, changed(base, lambda d: d["grid"].update(width=12)), etag)
    assert r.status_code == 422
    locs = [e["loc"] for e in r.json()["detail"]]
    assert ["body", "floors", 0, "cells", "16,0"] in locs  # same subject as the new ones: listed
    assert {e["type"] for e in r.json()["detail"]} == {"house_outside_grid"}  # untouched subjects: not


def test_semantic_check_reads_the_disk_not_a_lagging_index(editor: TestClient, example_root: Path):
    """The file is replaced behind the index's back; the judgement follows the disk both ways."""
    path = example_root / "house.json"
    clean = path.read_bytes()
    data, _ = house_of(editor)
    leftover = changed(data, INHERITED["unknown_room"])
    path.write_text(json.dumps(leftover, indent=2))  # no rescan
    r = put_house(editor, changed(leftover, lambda d: d["rooms"][0].update(name="X")), content_hash(path.read_bytes()))
    assert r.status_code == 200, r.text
    path.write_bytes(clean)  # the index now remembers the leftover, the disk doesn't
    r = put_house(editor, leftover, content_hash(clean))
    assert r.status_code == 422 and [e["type"] for e in r.json()["detail"]] == ["house_unknown_room"]


def test_a_422_announces_nothing(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, anon_role="editor")
    base, etag = on_disk(c, example_root, INHERITED["unknown_room"])
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        assert [next(it)[0] for _ in range(2)] == ["retry", "resync"]
        assert put_house(c, changed(base, lambda d: cells(d).update({"1,0": "rm_gone"})), etag).status_code == 422
        ok = put_house(c, changed(base, lambda d: d["rooms"][0].update(name="X")), etag)
        assert ok.status_code == 200
        # The first event after the 422 is the 200's own house.changed.
        assert next(it) == ("house.changed", {"etag": ok.headers["etag"].strip('"'), "readOnly": False})
