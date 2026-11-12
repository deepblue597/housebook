"""Your own textures (D43): images people upload for floors and wallpapers, kept in `Textures/`
at the data root and listed in `Textures/textures.json`, so they are backed up and synced with
everything else. Rooms refer to one by its key, exactly like a built-in finish
(`rooms[].floor`, `rooms[].walls`): `house.json` doesn't change. Keys start with `my_`, which no
built-in finish key may use, so a newer catalogue can never take over someone's texture.

Only the server writes the manifest (single writer, D8); a hand edit is read like any other file.
"""

import json
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from pydantic.alias_generators import to_camel

from housebook.domain.house import HEX_COLOR
from housebook.domain.paths import is_safe_name

TEXTURES_DIR = "Textures"
MANIFEST_NAME = "textures.json"
MANIFEST_REL = f"{TEXTURES_DIR}/{MANIFEST_NAME}"
OWN_PREFIX = "my_"
OWN_KEY = r"^my_[a-z0-9_]{1,37}$"  # also a valid finish key (house.FINISH_KEY)
MAX_LABEL = 60
MAX_TEXTURES = 200
MAX_SIZE_M = 20.0  # metres, as for built-in finishes
MAX_MANIFEST_BYTES = 1024 * 1024

TextureKind = Literal["floor", "wallpaper"]


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, extra="forbid", frozen=True)


class OwnTexture(_Model):
    key: str = Field(pattern=OWN_KEY)
    label: str = Field(min_length=1, max_length=MAX_LABEL)
    kind: TextureKind
    file: str = Field(description="Image file in Textures/")
    size: tuple[float, float] = Field(description="Metres the image covers before it repeats [x, y]")
    color: str = Field(pattern=HEX_COLOR, description="Average colour: the flat look and the fallback")

    @field_validator("file")
    @classmethod
    def _file_is_a_name(cls, v: str) -> str:
        if not is_safe_name(v) or v == MANIFEST_NAME:
            raise ValueError("file must be a file name inside Textures/")
        return v

    @field_validator("size")
    @classmethod
    def _size_in_range(cls, v: tuple[float, float]) -> tuple[float, float]:
        if not all(0 < s <= MAX_SIZE_M for s in v):
            raise ValueError(f"size must be in metres, 0 < size <= {MAX_SIZE_M:g}")
        return v


class TextureManifest(_Model):
    version: Literal[1] = 1
    textures: tuple[OwnTexture, ...] = ()

    @model_validator(mode="after")
    def _unique(self) -> Self:
        keys = [t.key for t in self.textures]
        if len(set(keys)) != len(keys):
            raise ValueError("texture keys must be unique")
        files = [t.file.casefold() for t in self.textures]
        if len(set(files)) != len(files):
            raise ValueError("each texture needs its own file")
        if len(self.textures) > MAX_TEXTURES:
            raise ValueError(f"at most {MAX_TEXTURES} textures")
        return self

    def get(self, key: str) -> OwnTexture | None:
        return next((t for t in self.textures if t.key == key), None)

    def keys_of(self, kind: TextureKind) -> frozenset[str]:
        return frozenset(t.key for t in self.textures if t.kind == kind)


class ManifestError(ValueError):
    """`Textures/textures.json` exists but isn't a valid manifest."""


def parse_manifest(raw: bytes) -> TextureManifest:
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ManifestError(f"{MANIFEST_REL} is larger than {MAX_MANIFEST_BYTES // 1024} KiB")
    try:
        return TextureManifest.model_validate(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ManifestError(f"{MANIFEST_REL} is not valid JSON") from e
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "file"
        raise ManifestError(f"{MANIFEST_REL}: {where}: {first['msg']}") from e


def serialize_manifest(manifest: TextureManifest) -> bytes:
    data = manifest.model_dump(mode="json", by_alias=True)
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
