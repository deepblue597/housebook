"""house.json v1 -> v2 (D41): v2 only adds optional keys (room `floor` and `walls`, the house's
`exteriorWallColor`), so a v1 file is a v2 file with a new version number."""

from typing import Any


def migrate(data: dict[str, Any]) -> dict[str, Any]:
    return {**data, "schemaVersion": 2}
