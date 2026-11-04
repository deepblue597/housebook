"""Item frontmatter fields: typed view over the raw string dict.

Field errors are not fatal: a bad date drops that one field and is reported as a problem,
so a typo never makes an item disappear from the plan.
"""

import calendar
import re
from datetime import date, timedelta
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, field_validator

from housebook.domain.house import ID_PATTERN

_NULLS = {"", "~", "null", "Null", "NULL"}
_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$")
_INTERVAL_RE = re.compile(r"^\s*(\d{1,4})\s*([dwmy])\s*$", re.IGNORECASE)
SAFE_URL_SCHEMES = {"http", "https", "mailto", "tel", "obsidian"}


def _scalar(v: Any) -> Any:
    if isinstance(v, (list, dict)):
        raise ValueError("expected a single value, not a list or mapping")
    return v


def _text(v: Any) -> str | None:
    v = _scalar(v)
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _date(v: Any) -> date | None:
    v = _scalar(v)
    if v is None or str(v).strip() in _NULLS:
        return None
    if isinstance(v, date):
        return v
    m = _DATE_RE.match(str(v).strip())
    if not m:
        raise ValueError("expected a date as YYYY-MM-DD")
    return date.fromisoformat(m[1])


def _bool(v: Any) -> bool | None:
    v = _scalar(v)
    if v is None or isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in {x.lower() for x in _NULLS}:
        return None
    if s in {"true", "yes", "on", "1"}:
        return True
    if s in {"false", "no", "off", "0"}:
        return False
    raise ValueError("expected true or false")


def _url(v: Any) -> str | None:
    s = _text(v)
    if s is None:
        return None
    scheme = urlsplit(s).scheme.lower()
    if scheme not in SAFE_URL_SCHEMES:
        raise ValueError(f"URL scheme must be one of {sorted(SAFE_URL_SCHEMES)}")
    return s


def _string_list(v: Any) -> list[str]:
    """Flatten; also accepts an unquoted `[[link]]`, which YAML reads as a nested list."""
    if v is None:
        return []
    if isinstance(v, str):
        return [v.strip()] if v.strip() else []
    if isinstance(v, list):
        out: list[str] = []
        for x in v:
            if isinstance(x, list) and len(x) == 1 and isinstance(x[0], str):
                out.append(f"[[{x[0]}]]")
            else:
                out.extend(_string_list(x))
        return out
    raise ValueError("expected a list of strings")


Text = Annotated[str | None, BeforeValidator(_text)]
DateField = Annotated[date | None, BeforeValidator(_date)]


class Interval(BaseModel):
    """Recurring check interval: `10d`, `2w`, `6m`, `1y`."""

    model_config = ConfigDict(frozen=True)

    count: int = Field(ge=1)
    unit: Literal["d", "w", "m", "y"]

    @classmethod
    def parse(cls, value: str) -> "Interval":
        m = _INTERVAL_RE.match(value)
        if not m:
            raise ValueError("expected an interval like 10d, 2w, 6m or 1y")
        return cls(count=int(m[1]), unit=m[2].lower())

    def __str__(self) -> str:
        return f"{self.count}{self.unit}"

    def add_to(self, start: date) -> date:
        if self.unit == "d":
            return start + timedelta(days=self.count)
        if self.unit == "w":
            return start + timedelta(weeks=self.count)
        months = self.count * (12 if self.unit == "y" else 1)
        y, m = divmod(start.month - 1 + months, 12)
        year, month = start.year + y, m + 1
        # Clamp to month end: 31 Jan + 1m = 28/29 Feb.
        return date(year, month, min(start.day, calendar.monthrange(year, month)[1]))


class ItemFields(BaseModel):
    """Known frontmatter keys. Names are the frontmatter keys themselves."""

    model_config = ConfigDict(frozen=True)

    housebook_id: Annotated[str | None, BeforeValidator(_text)] = Field(None, pattern=ID_PATTERN)
    type: Text = None
    name: Text = None
    brand: Text = None
    model: Text = None
    serial: Text = None
    purchased: DateField = None
    warranty_until: DateField = None
    next_check: DateField = None
    check_every: Interval | None = None
    manual: Annotated[str | None, BeforeValidator(_url)] = None
    support: Annotated[str | None, BeforeValidator(_url)] = None
    critical: Annotated[bool | None, BeforeValidator(_bool)] = None
    attachments: Annotated[list[str], BeforeValidator(_string_list)] = Field(default_factory=list)

    @field_validator("check_every", mode="before")
    @classmethod
    def _interval(cls, v: Any) -> Any:
        if isinstance(v, Interval):
            return v
        v = _scalar(v)
        if v is None or str(v).strip() in _NULLS:
            return None
        return Interval.parse(str(v))


KNOWN_KEYS = frozenset(ItemFields.model_fields)


class FieldError(BaseModel):
    key: str
    value: str
    message: str


def parse_fields(raw: dict[str, Any]) -> tuple[ItemFields, list[FieldError]]:
    """Typed fields plus per-field errors. Invalid fields are dropped, the rest kept."""
    known = {k: v for k, v in raw.items() if k in KNOWN_KEYS}
    errors: list[FieldError] = []
    for _ in range(len(known) + 1):
        try:
            return ItemFields.model_validate(known), errors
        except ValidationError as e:
            for err in e.errors():
                key = str(err["loc"][0])
                if key in known:
                    msg = err["msg"].removeprefix("Value error, ")
                    if key == "housebook_id":
                        msg = "id may only contain letters, digits, '_' and '-' (max 64)"
                    errors.append(FieldError(key=key, value=_preview(known.pop(key)), message=msg))
    raise AssertionError("unreachable")  # pragma: no cover


def _preview(v: Any) -> str:
    s = v if isinstance(v, str) else repr(v)
    return s if len(s) <= 80 else s[:77] + "..."


# --- body helpers (Markdown sections) -----------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_CODE_RE = re.compile(r"^\s*[-*+]\s+\*\*(.+?)\*\*")
_LOG_RE = re.compile(r"^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})\b")


def section_lines(body: str, title: str) -> list[str]:
    """Lines under every heading whose text equals `title` (case-insensitive), up to the
    next heading of the same or a higher level."""
    out: list[str] = []
    level: int | None = None
    for line in body.split("\n"):
        m = _HEADING_RE.match(line)
        if m:
            if level is not None and len(m[1]) <= level:
                level = None
            if m[2].strip().casefold() == title.casefold():
                level = len(m[1])
                continue
        if level is not None:
            out.append(line)
    return out


def error_codes(body: str) -> list[str]:
    """Bold text at the start of a list item under "Quick help": `- **E15**: ...` -> E15."""
    codes = []
    for line in section_lines(body, "Quick help"):
        m = _CODE_RE.match(line)
        if m:
            codes.append(m[1].strip().rstrip(":").strip())
    return codes


def last_log_date(body: str) -> date | None:
    """Latest `- YYYY-MM-DD ...` entry under "Maintenance log"."""
    dates = []
    for line in section_lines(body, "Maintenance log"):
        m = _LOG_RE.match(line)
        if m:
            try:
                dates.append(date.fromisoformat(m[1]))
            except ValueError:
                continue
    return max(dates) if dates else None
