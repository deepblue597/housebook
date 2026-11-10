"""house.json migrations: ordered, pure dict -> dict functions (DESIGN 15.4, D13).

To add v3: create `v2_to_v3.py` with `def migrate(data: dict) -> dict`, register it in
`MIGRATIONS` as `2: v2_to_v3.migrate`, bump `CURRENT_SCHEMA_VERSION` in domain/house.py and
update the Pydantic model. Each function must set `schemaVersion` to the new version.

A file with a newer `schemaVersion` than this image supports (after a rollback) is served
read-only and never written.
"""

import copy
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from housebook.domain.house import CURRENT_SCHEMA_VERSION
from housebook.migrations.house import v1_to_v2

Migration = Callable[[dict[str, Any]], dict[str, Any]]

# from_version -> function producing from_version + 1
MIGRATIONS: dict[int, Migration] = {1: v1_to_v2.migrate}


class MigrationError(ValueError):
    pass


@dataclass(frozen=True)
class Migrated:
    data: dict[str, Any]
    original_version: int
    migrated: bool  # True when at least one step ran (file is rewritten on the next save)
    read_only: bool  # True when the file is newer than this image


def schema_version_of(data: Any) -> int:
    if not isinstance(data, dict):
        raise MigrationError("house.json must be a JSON object")
    v = data.get("schemaVersion")
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise MigrationError("house.json needs an integer schemaVersion >= 1")
    return v


def migrate(
    data: Any,
    *,
    current: int = CURRENT_SCHEMA_VERSION,
    migrations: Mapping[int, Migration] = MIGRATIONS,
) -> Migrated:
    version = schema_version_of(data)
    if version > current:
        return Migrated(data, version, migrated=False, read_only=True)
    out = copy.deepcopy(data)
    v = version
    while v < current:
        step = migrations.get(v)
        if step is None:
            raise MigrationError(f"no migration from schemaVersion {v} to {v + 1}")
        out = step(out)
        if schema_version_of(out) != v + 1:
            raise MigrationError(f"migration {v} -> {v + 1} did not set schemaVersion {v + 1}")
        v += 1
    return Migrated(out, version, migrated=version != current, read_only=False)
