import copy
import json

import pytest
from pydantic import ValidationError

from conftest import CONTRACT, EXAMPLES
from housebook.domain.house import House, Placement, house_issues, json_schema, worse_issues


@pytest.fixture
def example() -> dict:
    return json.loads((EXAMPLES / "house.json").read_text(encoding="utf-8"))


def test_example_house_is_valid(example: dict):
    house = House.model_validate(example)
    assert house_issues(house) == []
    assert example["$schema"] == "../../contract/house.schema.json"
    assert len(house.placements) == 14 and len(house.openings) == 15


def test_committed_schema_is_up_to_date():
    committed = json.loads((CONTRACT / "house.schema.json").read_text(encoding="utf-8"))
    assert committed == json_schema(), "run: uv run housebook schema --out ../../contract/house.schema.json"


def test_dump_round_trips_and_sorts_cells(example: dict):
    house = House.model_validate(example)
    dumped = house.dump()
    assert House.model_validate(dumped) == house
    keys = list(dumped["floors"][0]["cells"])
    assert keys[0] == "1,1" and keys[1] == "2,1"  # row-major: y, then x
    assert "footprint" not in dumped["placements"][0]


def _broken(example: dict, mutate) -> dict:
    data = copy.deepcopy(example)
    mutate(data)
    return data


@pytest.mark.parametrize(
    "mutate, code",
    [
        (lambda d: d["rooms"].append(dict(d["rooms"][0])), "house_duplicate_id"),
        (lambda d: d["floors"].append(dict(d["floors"][0])), "house_duplicate_id"),
        (lambda d: d["placements"].append(dict(d["placements"][0], x=0, y=0)), "house_duplicate_placement"),
        (lambda d: d["floors"][0]["cells"].update({"16,0": "rm_kit"}), "house_outside_grid"),
        (lambda d: d["floors"][0]["cells"].update({"0,0": "rm_nope"}), "house_unknown_room"),
        (lambda d: d["floors"][0]["cells"].update({"01,0": "rm_kit"}), "house_bad_cell"),
        (lambda d: d["placements"][0].update(floorId="fl_nope"), "house_unknown_floor"),
        (lambda d: d["placements"][0].update(x=15, footprint=[2, 1]), "house_outside_grid"),
        (
            lambda d: d["openings"].append({"floorId": "fl_0", "x": 16, "y": 0, "side": "n", "kind": "door"}),
            "house_outside_grid",
        ),
    ],
)
def test_semantic_rules(example: dict, mutate, code: str):
    data = _broken(example, mutate)
    with pytest.raises(ValidationError):
        House.model_validate(data)
    tolerant = House.model_validate(data, context={"tolerant": True})
    assert code in {i.code for i in house_issues(tolerant)}


@pytest.mark.parametrize(
    "opening, ok",
    [
        ({"x": 16, "y": 0, "side": "w"}, True),  # east boundary edge
        ({"x": 0, "y": 10, "side": "n"}, True),  # south boundary edge
        ({"x": 16, "y": 0, "side": "n"}, False),
        ({"x": 0, "y": 10, "side": "w"}, False),
    ],
)
def test_opening_boundaries(example: dict, opening: dict, ok: bool):
    example["openings"] = [{"floorId": "fl_0", "kind": "window", **opening}]
    house = House.model_validate(example, context={"tolerant": True})
    assert (house_issues(house) == []) is ok


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(extra=1),
        lambda d: d["grid"].update(width=0),
        lambda d: d["rooms"][0].update(color="red"),
        lambda d: d["placements"][0].update(rotation=45),
        lambda d: d["openings"][0].update(side="s"),
        lambda d: d.update(schemaVersion=2),
        lambda d: d.update(floors=[]),
    ],
)
def test_structural_errors(example: dict, mutate):
    with pytest.raises(ValidationError):
        House.model_validate(_broken(example, mutate), context={"tolerant": True})


def test_lenient_drops_unknown_keys(example: dict):
    example["futureField"] = {"x": 1}
    example["rooms"][0]["texture"] = "wood"
    house = House.model_validate(example, context={"lenient": True})
    assert house.rooms[0].name == "Living room"


@pytest.mark.parametrize(
    "rotation, footprint, rect",
    [(0, (2, 1), (3, 4, 5, 5)), (90, (2, 1), (3, 4, 4, 6)), (180, (2, 1), (3, 4, 5, 5)), (270, (2, 1), (3, 4, 4, 6))],
)
def test_footprint_anchor_and_rotation(rotation: int, footprint: tuple[int, int], rect: tuple[int, int, int, int]):
    p = Placement.model_validate({"itemId": "it_a", "floorId": "f", "x": 3, "y": 4, "rotation": rotation})
    assert p.occupied(footprint) == rect


def _issues(example: dict, mutate) -> list:
    return house_issues(House.model_validate(_broken(example, mutate), context={"tolerant": True}))


def test_issue_subjects_leave_out_indexes_and_coordinates(example: dict):
    def two_tiles_and_a_stray(d: dict) -> None:
        d["floors"][0]["cells"].update({"0,0": "rm_gone", "16,0": "rm_kit"})
        d["placements"].append(dict(d["placements"][0], x=0, y=0))
        d["placements"][1].update(floorId="fl_nope")
        d["openings"][0].update(floorId="fl_nope")
        d["rooms"].append(dict(d["rooms"][0]))

    p0, p1 = example["placements"][0]["itemId"], example["placements"][1]["itemId"]
    room = example["rooms"][0]["id"]
    got = {(i.code, i.subject) for i in _issues(example, two_tiles_and_a_stray)}
    assert got == {
        ("house_unknown_room", ("fl_0", "rm_gone")),
        ("house_outside_grid", ("cell", "fl_0")),
        ("house_duplicate_placement", (p0,)),
        ("house_unknown_floor", ("placement", p1)),
        ("house_unknown_floor", ("opening", "fl_nope")),
        ("house_duplicate_id", ("room", room)),
    }


def test_worse_issues_counts_per_subject(example: dict):
    def tiles(*keys: str):
        return lambda d: d["floors"][0]["cells"].update(dict.fromkeys(keys, "rm_gone"))

    baseline = _issues(example, tiles("0,0", "1,0"))
    assert worse_issues(_issues(example, tiles("0,0", "1,0")), baseline) == []
    assert worse_issues(_issues(example, tiles("5,5")), baseline) == []  # fewer, moved: fine
    assert len(worse_issues(_issues(example, tiles("0,0", "1,0", "2,0")), baseline)) == 3
    assert worse_issues(_issues(example, tiles("0,0")), []) != []  # no file: everything is new
    bad = _issues(example, lambda d: d["floors"][0]["cells"].update({"01,0": "rm_kit"}))
    assert [i.code for i in worse_issues(bad, bad)] == ["house_bad_cell"]  # never let through
