"""Item type catalogue (contract/catalog.json). Type keys are a public contract: never rename
one, add an alias instead."""

import json
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from housebook.domain.house import Side

KEY_PATTERN = r"^[a-z][a-z0-9_]{0,39}$"


class ItemType(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", frozen=True)

    key: str = Field(pattern=KEY_PATTERN)
    label: str
    default_name: str
    footprint: tuple[Side, Side] = (1, 1)
    mount: Literal["floor", "wall", "ceiling"]
    critical: bool = False
    aliases: tuple[str, ...] = ()


class Catalog(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: int = 1
    types: tuple[ItemType, ...]

    @model_validator(mode="after")
    def _unique(self) -> Self:
        seen: set[str] = set()
        for t in self.types:
            for k in (t.key, *t.aliases):
                if k.casefold() in seen:
                    raise ValueError(f"catalogue key or alias '{k}' is defined twice")
                seen.add(k.casefold())
        return self

    def resolve(self, key: str | None) -> ItemType | None:
        """Look up a type by key or alias, case-insensitive."""
        if not key:
            return None
        k = key.strip().casefold()
        for t in self.types:
            if t.key == k or k in (a.casefold() for a in t.aliases):
                return t
        return None


def load_catalog(path: Path) -> Catalog:
    return Catalog.model_validate(json.loads(path.read_text(encoding="utf-8")))
