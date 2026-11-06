"""Integrity report entries (DESIGN 15.2). Problems are data, never exceptions."""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from typing_extensions import TypedDict  # PEP 728 `extra_items` (pydantic depends on typing_extensions)


class Severity(StrEnum):
    error = "error"
    warning = "warning"
    info = "info"


class ProblemKind(StrEnum):
    # house.json
    house_missing = "house_missing"
    house_invalid = "house_invalid"
    house_newer_version = "house_newer_version"
    house_duplicate_id = "house_duplicate_id"
    house_bad_cell = "house_bad_cell"
    house_unknown_room = "house_unknown_room"
    house_unknown_floor = "house_unknown_floor"
    house_outside_grid = "house_outside_grid"
    house_duplicate_placement = "house_duplicate_placement"
    # notes
    note_parse_error = "note_parse_error"
    read_error = "read_error"
    note_invalid_field = "note_invalid_field"
    note_invalid_id = "note_invalid_id"
    duplicate_id = "duplicate_id"
    conflict_copy = "conflict_copy"
    not_adopted = "not_adopted"
    untagged_typed = "untagged_typed"
    unknown_type = "unknown_type"
    symlink_outside_root = "symlink_outside_root"
    # cross-file
    missing_note = "missing_note"
    attachment_missing = "attachment_missing"
    attachment_unsafe = "attachment_unsafe"
    attachment_name_collision = "attachment_name_collision"


class HouseProblemReason(StrEnum):
    """Why house.json is unusable: `detail.reason` on every `house_invalid` and
    `house_newer_version` problem. A closed set: clients switch on it, never on `message`."""

    unreadable = "unreadable"  # can't be read: permissions, I/O, not a regular file, unsafe path
    too_large = "too_large"  # larger than the 16 MiB limit, refused before parsing
    not_json = "not_json"  # not decodable UTF-8 JSON (incl. nesting too deep to parse)
    bad_version = "bad_version"  # schemaVersion missing / not an integer >= 1 / no migration path
    newer_version = "newer_version"  # schemaVersion newer than this image supports
    invalid = "invalid"  # JSON with a supported schemaVersion that fails structural validation


class ProblemDetail(TypedDict, total=False, extra_items=str):
    """Machine-readable extras; which keys appear depends on `kind` (data contract §7)."""

    reason: HouseProblemReason


class Problem(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, frozen=True)

    kind: ProblemKind
    severity: Severity
    message: str
    path: str | None = None
    item_id: str | None = None
    detail: ProblemDetail | None = Field(
        default=None,
        description="Extra string fields per kind: `reason` on house_invalid / house_newer_version, "
        "`key` on note_invalid_field, `canonical` on duplicate_id / conflict_copy",
    )
