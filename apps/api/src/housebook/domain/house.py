"""house.json v2: the layout (v2 adds floor and wall finishes, D41). See docs/data-contract.md for conventions.

Two layers of validation:
- structural (types, ranges, patterns): always enforced by Pydantic;
- semantic (unique ids, cells inside the grid, references): `house_issues()`.
  `House.model_validate(data)` rejects semantic issues too. Loading from disk passes
  `context={"tolerant": True}`; the issues then become problems. `PUT /api/house` also parses
  tolerantly and then rejects only issues that make the layout worse than the file on disk
  (`worse_issues`, D30).
"""

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    model_validator,
)
from pydantic.alias_generators import to_camel

CURRENT_SCHEMA_VERSION = 2

ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
CELL_KEY_RE = re.compile(r"^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$")
MAX_GRID = 512
# A finish from contract/finishes.json (an unknown key is a problem, not an error: the room is
# drawn in its plan colour). Wall finishes are a paint colour or a wallpaper key.
FINISH_KEY = r"^[a-z][a-z0-9_]{0,39}$"
HEX_COLOR = r"^#[0-9A-Fa-f]{6}$"
WALL_FINISH = r"^(#[0-9A-Fa-f]{6}|[a-z][a-z0-9_]{0,39})$"

Rotation = Literal[0, 90, 180, 270]
# Footprint sides in tiles: at least 1, at most the largest grid.
Side = Annotated[int, Field(ge=1, le=MAX_GRID)]


def _is_none(v: object) -> bool:
    return v is None


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _drop_unknown_when_lenient(cls, data: Any, info: ValidationInfo) -> Any:
        # Files written by a newer image are read leniently: unknown keys are dropped.
        if info.context and info.context.get("lenient") and isinstance(data, dict):
            known = {f.alias or name for name, f in cls.model_fields.items()}
            return {k: v for k, v in data.items() if k in known}
        return data


class Grid(_Model):
    tile_size: float = Field(1.0, gt=0, le=10, description="Metres per tile")
    width: int = Field(ge=1, le=MAX_GRID, description="Tiles along x (east)")
    depth: int = Field(ge=1, le=MAX_GRID, description="Tiles along y (south)")


class Room(_Model):
    id: str = Field(pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(pattern=HEX_COLOR)
    floor: str | None = Field(
        None, pattern=FINISH_KEY, description="Floor finish key (contract/finishes.json)", exclude_if=_is_none
    )
    walls: str | None = Field(
        None,
        pattern=WALL_FINISH,
        description="Wall finish: a paint colour #RRGGBB or a wallpaper key (contract/finishes.json)",
        exclude_if=_is_none,
    )


class Floor(_Model):
    id: str = Field(pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    level: int = Field(0, ge=-20, le=200)
    cells: dict[str, str] = Field(
        default_factory=dict,
        description='Map of "x,y" -> room id. Keys are non-negative integers without padding.',
        json_schema_extra={"propertyNames": {"pattern": CELL_KEY_RE.pattern}},
    )


class Placement(_Model):
    item_id: str = Field(pattern=ID_PATTERN)
    floor_id: str = Field(pattern=ID_PATTERN)
    x: int = Field(ge=0, description="Minimum x of the occupied rectangle after rotation")
    y: int = Field(ge=0, description="Minimum y of the occupied rectangle after rotation")
    rotation: Rotation = Field(0, description="Degrees clockwise seen from above; 0 = front faces +y")
    footprint: tuple[Side, Side] | None = Field(
        None,
        description="[w, d] override of the catalogue footprint, before rotation",
        exclude_if=_is_none,
    )

    def occupied(self, default_footprint: tuple[int, int] = (1, 1)) -> tuple[int, int, int, int]:
        """(x0, y0, x1, y1) exclusive. Rotation by 90/270 swaps w and d."""
        w, d = self.footprint or default_footprint
        if self.rotation in (90, 270):
            w, d = d, w
        return self.x, self.y, self.x + w, self.y + d


class Opening(_Model):
    floor_id: str = Field(pattern=ID_PATTERN)
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    side: Literal["n", "w"] = Field(description="Edge of tile (x,y): n = north (towards y-1), w = west (towards x-1)")
    kind: Literal["door", "window", "open"] = Field(
        description="open: no wall on this edge between two rooms (open plan, D51); ignored elsewhere"
    )


class House(_Model):
    schema_: str | None = Field(None, alias="$schema", exclude_if=_is_none)
    schema_version: Literal[2] = Field(alias="schemaVersion")
    grid: Grid
    exterior_wall_color: str | None = Field(
        None, pattern=HEX_COLOR, description="Outside walls, the whole house (#RRGGBB)", exclude_if=_is_none
    )
    rooms: list[Room] = Field(default_factory=list)
    floors: list[Floor] = Field(min_length=1)
    placements: list[Placement] = Field(default_factory=list)
    openings: list[Opening] = Field(default_factory=list)

    @model_validator(mode="after")
    def _semantic_rules(self, info: ValidationInfo) -> Self:
        if info.context and (info.context.get("tolerant") or info.context.get("lenient")):
            return self
        issues = house_issues(self)
        if issues:
            raise ValueError("; ".join(i.message for i in issues[:20]))
        return self

    def dump(self) -> dict[str, Any]:
        """JSON-ready dict in file form (aliases, no nulls, sorted cell keys)."""
        data = self.model_dump(mode="json", by_alias=True)
        for floor in data["floors"]:
            floor["cells"] = dict(sorted(floor["cells"].items(), key=lambda kv: _cell_sort(kv[0])))
        return data


def _cell_sort(key: str) -> tuple[int, int, str]:
    m = CELL_KEY_RE.match(key)
    return (int(m[2]), int(m[1]), "") if m else (1 << 30, 1 << 30, key)


def parse_cell_key(key: str) -> tuple[int, int] | None:
    m = CELL_KEY_RE.match(key)
    return (int(m[1]), int(m[2])) if m else None


_LOOSE_CELL_KEY_RE = re.compile(r"^\s*\+?(\d{1,6})\s*,\s*\+?(\d{1,6})\s*$")


def normalise_cells(data: Any) -> tuple[Any, list["HouseIssue"]]:
    """For a house.json read from disk: rewrite loose cell keys (`"01,0"`, `" 1, 0"`) to the
    canonical `"1,0"` and drop keys that are not two non-negative integers, so the API never
    serves keys its own schema rejects. Each change is returned as a `house_bad_cell` issue.
    A non-canonical key that collides with an existing canonical one is dropped.
    Anything that isn't shaped like a house is returned unchanged for validation to reject."""
    issues: list[HouseIssue] = []
    if not isinstance(data, dict) or not isinstance(data.get("floors"), list):
        return data, issues
    floors = []
    for floor in data["floors"]:
        cells = floor.get("cells") if isinstance(floor, dict) else None
        if not isinstance(cells, dict) or all(isinstance(k, str) and CELL_KEY_RE.match(k) for k in cells):
            floors.append(floor)
            continue
        fid = floor.get("id")
        out = {k: v for k, v in cells.items() if CELL_KEY_RE.match(k)}
        for key, room in cells.items():
            if CELL_KEY_RE.match(key):
                continue
            m = _LOOSE_CELL_KEY_RE.match(key)
            if not m:
                issues.append(HouseIssue("house_bad_cell", f"floor '{fid}': bad cell key '{key}' ignored"))
                continue
            canonical = f"{int(m[1])},{int(m[2])}"
            if canonical in out:
                issues.append(
                    HouseIssue("house_bad_cell", f"floor '{fid}': cell key '{key}' duplicates '{canonical}'; ignored")
                )
                continue
            out[canonical] = room
            issues.append(HouseIssue("house_bad_cell", f"floor '{fid}': cell key '{key}' read as '{canonical}'"))
        floors.append({**floor, "cells": out})
    return {**data, "floors": floors}, issues


@dataclass(frozen=True)
class HouseIssue:
    code: str  # maps onto a ProblemKind
    message: str
    loc: tuple[str | int, ...] = field(default=())  # JSON path of the offending value
    # What the issue is about, without list indexes or coordinates, so the same problem keeps its
    # key when things are moved, resized or reordered (D30). `worse_issues` counts by (code, subject).
    subject: tuple[str, ...] = field(default=())


def house_issues(house: House) -> list[HouseIssue]:
    """Semantic checks from DESIGN 15.2. Empty list means the layout is consistent."""
    out: list[HouseIssue] = []
    w, d = house.grid.width, house.grid.depth

    def dupes(kind: str, ids: list[str]) -> None:
        seen: set[str] = set()
        for n, i in enumerate(ids):
            if i in seen:
                out.append(
                    HouseIssue("house_duplicate_id", f"duplicate {kind} id '{i}'", (f"{kind}s", n, "id"), (kind, i))
                )
            seen.add(i)

    dupes("room", [r.id for r in house.rooms])
    dupes("floor", [f.id for f in house.floors])

    room_ids = {r.id for r in house.rooms}
    floor_ids = {f.id for f in house.floors}
    for fi, floor in enumerate(house.floors):
        for key, room_id in floor.cells.items():
            loc = ("floors", fi, "cells", key)
            xy = parse_cell_key(key)
            if xy is None:
                out.append(
                    HouseIssue("house_bad_cell", f"floor '{floor.id}': bad cell key '{key}'", loc, ("cell", floor.id))
                )
                continue
            if not (xy[0] < w and xy[1] < d):
                out.append(
                    HouseIssue(
                        "house_outside_grid",
                        f"floor '{floor.id}': cell {key} is outside the grid",
                        loc,
                        ("cell", floor.id),
                    )
                )
            if room_id not in room_ids:
                out.append(
                    HouseIssue(
                        "house_unknown_room",
                        f"floor '{floor.id}': cell {key} points to unknown room '{room_id}'",
                        loc,
                        (floor.id, room_id),
                    )
                )

    placed: set[str] = set()
    for pi, p in enumerate(house.placements):
        loc = ("placements", pi)
        if p.item_id in placed:
            out.append(
                HouseIssue(
                    "house_duplicate_placement",
                    f"item '{p.item_id}' is placed more than once",
                    (*loc, "itemId"),
                    (p.item_id,),
                )
            )
        placed.add(p.item_id)
        if p.floor_id not in floor_ids:
            out.append(
                HouseIssue(
                    "house_unknown_floor",
                    f"placement of '{p.item_id}' references unknown floor '{p.floor_id}'",
                    (*loc, "floorId"),
                    ("placement", p.item_id),
                )
            )
        _, _, x1, y1 = p.occupied()
        if x1 > w or y1 > d:
            out.append(
                HouseIssue(
                    "house_outside_grid",
                    f"placement of '{p.item_id}' at {p.x},{p.y} is outside the grid",
                    loc,
                    ("placement", p.item_id),
                )
            )

    for oi, o in enumerate(house.openings):
        loc = ("openings", oi)
        if o.floor_id not in floor_ids:
            out.append(
                HouseIssue(
                    "house_unknown_floor",
                    f"opening at {o.x},{o.y} references unknown floor '{o.floor_id}'",
                    (*loc, "floorId"),
                    ("opening", o.floor_id),
                )
            )
        # The east/south boundary edges are addressed from x == width / y == depth.
        ok = (o.x < w and o.y <= d) if o.side == "n" else (o.x <= w and o.y < d)
        if not ok:
            out.append(
                HouseIssue(
                    "house_outside_grid",
                    f"opening {o.side} at {o.x},{o.y} is outside the grid",
                    loc,
                    ("opening", o.floor_id),
                )
            )
    return out


# Never let through, whatever the baseline: the server normalises bad keys when it reads a file,
# so a client that sends one has a bug (D30).
ALWAYS_REJECTED = frozenset({"house_bad_cell"})


def worse_issues(new: list[HouseIssue], baseline: list[HouseIssue]) -> list[HouseIssue]:
    """D30: the issues of `new` that make the layout worse than `baseline` (the file on disk).

    Issues are counted per `(code, subject)`; every issue of a key that occurs more often than in
    the baseline is returned (which copy is "the new one" can't be told without positions).
    Inherited issues may stay, move or shrink. `ALWAYS_REJECTED` codes are always returned."""
    before = Counter((i.code, i.subject) for i in baseline)
    after = Counter((i.code, i.subject) for i in new)
    return [i for i in new if i.code in ALWAYS_REJECTED or after[(i.code, i.subject)] > before[(i.code, i.subject)]]


def serialize(house: House) -> bytes:
    """Deterministic file form (DESIGN 15.2): 2-space indent, cell keys sorted by y then x,
    nulls omitted, UTF-8, trailing newline. Diffs in git and restic stay readable."""
    return (json.dumps(house.dump(), indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def room_at(house: House, floor_id: str, x: int, y: int) -> str | None:
    for floor in house.floors:
        if floor.id == floor_id:
            return floor.cells.get(f"{x},{y}")
    return None


def json_schema() -> dict[str, Any]:
    schema = House.model_json_schema(by_alias=True, mode="validation")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://housebook.local/contract/house.schema.json",
        "title": "Housebook house.json",
        "description": (
            "Layout of one home (schemaVersion 1). Semantic rules (unique ids, cells inside the grid, "
            "references to existing rooms/floors, one placement per item) are checked by the server."
        ),
        **{k: v for k, v in schema.items() if k != "title"},
    }
