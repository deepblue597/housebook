"""Integrity report entries (DESIGN 15.2). Problems are data, never exceptions."""

from enum import StrEnum

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


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


class Problem(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, frozen=True)

    kind: ProblemKind
    severity: Severity
    message: str
    path: str | None = None
    item_id: str | None = None
    detail: dict[str, str] | None = None
