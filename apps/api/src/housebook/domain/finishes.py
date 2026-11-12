"""Floor and wall finishes (contract/finishes.json, D41): the names `house.json` may use for a
room's `floor` and `walls`. Like item types, keys are a public contract: never rename one."""

import json
from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from housebook.domain.house import FINISH_KEY, HEX_COLOR


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", frozen=True)


class Finish(_Model):
    key: str = Field(pattern=FINISH_KEY)
    label: str
    group: str | None = None
    color: str = Field(pattern=HEX_COLOR, description="Average colour: the flat look and the fallback")
    texture: str | None = Field(
        None, pattern=r"^[a-z0-9_-]{1,60}\.(jpg|png|webp)$", description="File in apps/web/src/assets/textures (D42)"
    )
    size: tuple[float, float] | None = Field(None, description="Metres the texture covers before it repeats [x, y]")

    @model_validator(mode="after")
    def _size_positive(self) -> Self:
        if self.size and not all(0 < s <= 20 for s in self.size):
            raise ValueError("size must be in metres, 0 < size <= 20")
        return self


class Paint(_Model):
    label: str
    color: str = Field(pattern=HEX_COLOR)


class Finishes(_Model):
    version: int = 1
    floors: tuple[Finish, ...]
    wallpapers: tuple[Finish, ...]
    paints: tuple[Paint, ...]
    exterior_default: str = Field(pattern=HEX_COLOR)

    @model_validator(mode="after")
    def _no_own_prefix(self) -> Self:
        # `my_` keys belong to uploaded textures (domain/textures.py, D43).
        if any(f.key.startswith("my_") for f in (*self.floors, *self.wallpapers)):
            raise ValueError("built-in finish keys must not start with 'my_'")
        return self

    @property
    def floor_keys(self) -> frozenset[str]:
        return frozenset(f.key for f in self.floors)

    @property
    def wallpaper_keys(self) -> frozenset[str]:
        return frozenset(w.key for w in self.wallpapers)


def load_finishes(path: Path) -> Finishes:
    return Finishes.model_validate(json.loads(path.read_text(encoding="utf-8")))
