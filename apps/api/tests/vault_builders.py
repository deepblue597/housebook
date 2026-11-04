"""Small data-root builders shared by tests/api (in-process) and tests/blackbox (real server).

`nasty_vault.build` covers the awkward-file catalogue from DESIGN 15.15; these helpers add
targeted cases (search tiers, due ordering, pathological YAML/JSON) and a bulk generator for
the performance sanity checks.
"""

import json
import os
import random
from pathlib import Path
from typing import Any

PDF = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


def house(**overrides: Any) -> dict[str, Any]:
    """A minimal valid house.json v1 (4x3 grid, one room, one floor)."""
    data: dict[str, Any] = {
        "schemaVersion": 1,
        "grid": {"tileSize": 1, "width": 4, "depth": 3},
        "rooms": [{"id": "r1", "name": "Kitchen", "color": "#E3A94B"}],
        "floors": [{"id": "f1", "name": "Ground", "level": 0, "cells": {"0,0": "r1"}}],
        "placements": [],
        "openings": [],
    }
    data.update(overrides)
    return data


def note(fm: str, body: str = "") -> str:
    return f"---\n{fm.strip()}\n---\n{body}"


def write(root: Path, rel: str, content: str | bytes, mtime: int | None = None) -> Path:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, str):
        p.write_text(content, encoding="utf-8", newline="")
    else:
        p.write_bytes(content)
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def write_house(root: Path, data: dict[str, Any] | str) -> None:
    write(root, "house.json", data if isinstance(data, str) else json.dumps(data, indent=2))


def item(root: Path, item_id: str, fm: str = "", body: str = "", rel: str | None = None) -> Path:
    return write(root, rel or f"House/{item_id}.md", note(f"housebook_id: {item_id}\n{fm}", body))


def build_search_tiers(root: Path) -> None:
    """Token `zx9` hits a different tier in each item (DESIGN 15.9 ranking)."""
    rooms = [{"id": "r1", "name": "ZX9 room", "color": "#000000"}]
    cells = {"0,0": "r1"}
    write_house(
        root,
        house(
            rooms=rooms,
            floors=[{"id": "f1", "name": "G", "cells": cells}],
            placements=[{"itemId": "it_room", "floorId": "f1", "x": 0, "y": 0, "rotation": 0}],
        ),
    )
    item(root, "it_body", "name: Echo", "Some zx9 text in the body\n")
    item(root, "it_room", "name: Delta")
    item(root, "it_model", "name: Charlie\nmodel: AB-ZX9")
    item(root, "it_code", "name: Bravo", "## Quick help\n- **ZX9**: something\n")
    item(root, "it_name2", "name: Zz Zx9 thing")
    item(root, "it_name1", "name: zx9 first")


def build_due(root: Path) -> None:
    """Items for `?due=N` (today = 2026-11-04)."""
    write_house(root, house())
    item(root, "d_expired_soon", "name: Expired, check in 21\nwarranty_until: 2020-01-01\nnext_check: 2026-11-25")
    item(root, "d_overdue", "name: Overdue by 3\nnext_check: 2026-11-01")
    item(root, "d_warranty10", "name: Warranty ends in 10\nwarranty_until: 2026-11-14\nnext_check: 2030-01-01")
    item(root, "d_today", "name: Due today\nnext_check: 2026-11-04")
    item(root, "d_far", "name: Scheduled far\nnext_check: 2027-06-01")
    item(root, "d_wfar", "name: Warranty far\nwarranty_until: 2030-01-01")


def alias_bomb(levels: int, fanout: int = 10) -> str:
    """YAML 'billion laughs': `levels` nested aliases expand to fanout**(levels+1) scalars."""
    lines = ["a0: &a0 [" + ",".join(["x"] * fanout) + "]"]
    for i in range(1, levels + 1):
        lines.append(f"a{i}: &a{i} [" + ",".join([f"*a{i - 1}"] * fanout) + "]")
    return "\n".join(lines)


GREEK_WORDS = ["ψυγείο", "πλυντήριο", "κλιματιστικό", "θερμοσίφωνας", "κουζίνα", "σαλόνι", "μπάνιο", "αποθήκη"]
TYPES = ["fridge", "washer", "dishwasher", "oven", "router", "boiler", "tv", "ac"]


def build_bulk(root: Path, n: int = 500, seed: int = 7, body_kb: int = 2) -> None:
    """`n` realistic notes (~body_kb KB each), most placed, a few with attachments."""
    rng = random.Random(seed)
    width, depth = 40, 30
    cells = {f"{x},{y}": f"r{(x // 10) + 4 * (y // 10)}" for x in range(width) for y in range(depth)}
    rooms = [{"id": f"r{i}", "name": f"Room {i}", "color": "#AABBCC"} for i in range(12)]
    placements = []
    for i in range(n):
        item_id = f"it_{i:06d}"
        room = f"Room{i % 12}"
        if i % 10:
            placements.append({"itemId": item_id, "floorId": "f1", "x": i % width, "y": (i // width) % depth})
        filler = " ".join(rng.choice(GREEK_WORDS + ["lorem", "ipsum", "filter", "drain"]) for _ in range(body_kb * 150))
        body = (
            f"## Quick help\n- **E{i % 50}**: error {i}\n- Not working: check the breaker\n\n"
            f"## Maintenance log\n- 2026-0{1 + i % 9}-1{i % 10} Service visit\n\n## Notes\n{filler}\n"
        )
        fm = (
            f"type: {TYPES[i % len(TYPES)]}\nname: Item {i} {GREEK_WORDS[i % len(GREEK_WORDS)]}\n"
            f"brand: Brand{i % 17}\nmodel: MDL-{i:04d}X\nserial: '{i:08d}'\npurchased: 2024-0{1 + i % 9}-15\n"
            f"warranty_until: 2027-0{1 + i % 9}-15\ncheck_every: {1 + i % 12}m\ntags: [housebook]"
        )
        item(root, item_id, fm, body, rel=f"House/{room}/Item {i}.md")
        if i % 25 == 0:
            write(root, f"House/{room}/Item {i}/manual.pdf", PDF)
    write_house(
        root,
        house(
            grid={"tileSize": 1, "width": width, "depth": depth},
            rooms=rooms,
            floors=[{"id": "f1", "name": "G", "cells": cells}],
            placements=placements,
        ),
    )
