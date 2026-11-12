"""Floor and wall finishes (contract/finishes.json, D41): the names `house.json` may use for a
room's `floor` and `walls`. Like item types, keys are a public contract: never rename one."""

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from housebook.domain.house import FINISH_KEY, HEX_COLOR


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", frozen=True)


class Finish(_Model):
    key: str = Field(pattern=FINISH_KEY)
    label: str
    group: str | None = None
    color: str = Field(pattern=HEX_COLOR, description="Average colour: the flat look and the fallback")


class Paint(_Model):
    label: str
    color: str = Field(pattern=HEX_COLOR)


class Finishes(_Model):
    version: int = 1
    floors: tuple[Finish, ...]
    wallpapers: tuple[Finish, ...]
    paints: tuple[Paint, ...]
    exterior_default: str = Field(pattern=HEX_COLOR)

    @property
    def floor_keys(self) -> frozenset[str]:
        return frozenset(f.key for f in self.floors)

    @property
    def wallpaper_keys(self) -> frozenset[str]:
        return frozenset(w.key for w in self.wallpapers)


def load_finishes(path: Path) -> Finishes:
    return Finishes.model_validate(json.loads(path.read_text(encoding="utf-8")))
