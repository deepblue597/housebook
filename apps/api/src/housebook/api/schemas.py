"""Response models. The envelope is camelCase (like house.json); `fields` and `frontmatter`
are keyed by the frontmatter keys themselves (snake_case), since that's what writes patch."""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from housebook.domain.house import House
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


class SnapshotOut(ApiModel):
    today: date = Field(description="Today in HOUSEBOOK_TZ; statuses are computed against it")
    timezone: str
    house: House | None
    house_etag: str | None
    house_read_only: bool
    house_schema_version: int | None
    items: list[ItemDetailOut]
    problem_count: int


class ProblemsOut(ApiModel):
    problems: list[Problem]
    count: int
    scanned_at: datetime


class MeOut(ApiModel):
    user: str | None
    role: Literal["viewer", "editor"]
    auth_mode: Literal["none", "proxy"]


class HealthOut(ApiModel):
    status: str
    checks: dict[str, bool] = Field(default_factory=dict)
