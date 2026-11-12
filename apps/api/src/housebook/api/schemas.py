"""Response models. The envelope is camelCase (like house.json); `fields` and `frontmatter`
are keyed by the frontmatter keys themselves (snake_case), since that's what writes patch."""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from pydantic.alias_generators import to_camel

from housebook.domain.house import ID_PATTERN, House
from housebook.domain.problems import Problem
from housebook.domain.status import Status


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, serialize_by_alias=True)


class ItemFieldsOut(BaseModel):
    """Typed frontmatter. Invalid values are null here and listed in /api/problems."""

    type: str | None = None
    name: str | None = None
    brand: str | None = None
    model: str | None = None
    serial: str | None = None
    purchased: date | None = None
    warranty_until: date | None = None
    next_check: date | None = None
    check_every: str | None = Field(None, description="Interval like 6m or 1y")
    manual: str | None = None
    support: str | None = None
    critical: bool | None = None
    attachments: list[str] = Field(default_factory=list)


class AttachmentOut(ApiModel):
    name: str
    size: int
    listed: bool = Field(description="Listed in frontmatter (vs. only found in the sibling folder)")
    url: str


class LocationOut(ApiModel):
    floor_id: str
    room_id: str | None
    x: int
    y: int
    rotation: int


class ItemOut(ApiModel):
    id: str
    path: str = Field(description="Note path relative to the data root")
    etag: str = Field(description="Content hash of the note file; send as If-Match on writes")
    attachments_etag: str = Field(description="Changes when the attachment set changes (names, sizes, mtimes)")
    name: str = Field(description="`name`, or the file name when missing")
    type: str | None = Field(description="Canonical catalogue key (aliases resolved), or the raw value if unknown")
    type_known: bool
    critical: bool = Field(description="`critical` from frontmatter, else the catalogue default")
    fields: ItemFieldsOut
    frontmatter: dict[str, Any] = Field(description="All frontmatter keys as read (strings), unknown keys included")
    status: Status
    location: LocationOut | None = Field(description="Placement and derived room; null when unplaced")
    error_codes: list[str]
    attachments: list[AttachmentOut]
    stale: bool = Field(description="The file currently fails to parse; this is the last good version")
    parse_error: str | None = None
    obsidian_url: str | None = None


class ItemDetailOut(ItemOut):
    body: str


class ItemListOut(ApiModel):
    items: list[ItemOut]
    count: int


class TextureOut(ApiModel):
    """An uploaded texture (D43). Rooms use `key` in `floor` (kind `floor`) or `walls` (kind
    `wallpaper`), like a built-in finish key."""

    key: str
    label: str
    kind: Literal["floor", "wallpaper"]
    size: tuple[float, float] = Field(description="Metres the image covers before it repeats [x, y]")
    color: str = Field(description="Average colour: the flat look, and drawn while the image loads")
    url: str | None = Field(description="The image; changes when the file does. Null when the file is missing")


class SnapshotOut(ApiModel):
    today: date = Field(description="Today in HOUSEBOOK_TZ; statuses are computed against it")
    timezone: str
    house: House | None
    house_etag: str | None
    house_read_only: bool
    house_schema_version: int | None
    items_version: str = Field(description="Version of the item index; the SSE `resync` event carries the same value")
    items: list[ItemDetailOut]
    problem_count: int
    textures: list[TextureOut] = Field(description="Uploaded textures (D43)")
    textures_version: str = Field(description="Changes with `textures`; the SSE `resync` event carries the same value")


class ProblemsOut(ApiModel):
    problems: list[Problem]
    count: int
    scanned_at: datetime


class MeOut(ApiModel):
    user: str | None
    role: Literal["viewer", "editor"]
    auth_mode: Literal["none", "proxy"]


class CalendarLinkIn(ApiModel):
    """Empty: the body only has to be JSON, which a cross-site form can't send (DESIGN 15.13)."""

    model_config = ConfigDict(extra="forbid")


class CalendarLinkOut(ApiModel):
    """The caller's calendar link (D40). `url` only in the answer that made it: the code is
    stored hashed, so it can't be shown again."""

    exists: bool
    created_at: datetime | None = None
    url: str | None = Field(None, description="Subscribe to this; shown once")


class HealthOut(ApiModel):
    status: str
    checks: dict[str, bool] = Field(default_factory=dict)


# --- writes (milestone 4) ----------------------------------------------------------------------


class ApiIn(ApiModel):
    model_config = ConfigDict(extra="forbid")


Frontmatter = dict[str, JsonValue]


class ItemPatchIn(ApiIn):
    """PATCH /api/items/{id}. `frontmatter` is a JSON Merge Patch (RFC 7396) applied to the
    note's frontmatter: `null` deletes a key, objects merge, other values replace. `body`
    replaces the Markdown body only when present (non-null)."""

    frontmatter: Frontmatter | None = Field(None, description="JSON Merge Patch on the frontmatter")
    body: str | None = Field(None, description="New body, verbatim (the note is limited to 4 MiB: 413)")


class ItemCreateIn(ApiIn):
    type: str = Field(min_length=1, max_length=64, description="Catalogue key or alias")
    name: str | None = Field(None, max_length=200, description="Default: the catalogue's defaultName")
    room_id: str | None = Field(
        None, pattern=ID_PATTERN, description="Room whose name becomes the note's folder (House/<Room>/<Name>.md)"
    )
    frontmatter: Frontmatter = Field(
        default_factory=dict, description="Extra frontmatter (brand, model, ...); not housebook_id/type/name"
    )
    body: str | None = Field(None, description="Default: an empty note template (note limit 4 MiB: 413)")


class LogEntryIn(ApiIn):
    text: str = Field(min_length=1, max_length=1000, description="One line; whitespace is collapsed")
    day: date | None = Field(None, alias="date", description="YYYY-MM-DD; default: today in HOUSEBOOK_TZ")


class AdoptIn(ApiIn):
    path: str = Field(min_length=1, max_length=1024, description="Note path from a `not_adopted` problem")


class ErrorOut(BaseModel):
    """Error body. `detail` is a message, or for 422 a list of `{type, loc, msg}`."""

    detail: Any
    current_etag: str | None = Field(None, alias="currentEtag", description="On 412: the file's current ETag")
    reason: str | None = Field(None, description="On 409: machine-readable cause")
