"""Item status, computed, never stored (DESIGN §4, 15.16). Golden cases:
contract/fixtures/status_cases.json (shared with the frontend)."""

from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from housebook.domain.item import Interval

DUE_SOON_DAYS = 30
WARRANTY_ENDING_DAYS = 60

Level = Literal["overdue", "due_soon", "warranty_ending"]


class CheckStatus(BaseModel):
    state: Literal["overdue", "due_soon", "scheduled"]
    date: date
    days: int  # negative when overdue
    derived: bool  # True when computed from check_every rather than next_check


class WarrantyStatus(BaseModel):
    state: Literal["expired", "ending", "active"]
    date: date
    days: int


class Status(BaseModel):
    level: Level | None  # the badge: worst of check and warranty; None = nothing to flag
    check: CheckStatus | None
    warranty: WarrantyStatus | None


def today_in(tz: str, now: datetime | None = None) -> date:
    """Today's date in the household time zone (HOUSEBOOK_TZ)."""
    zone = ZoneInfo(tz)
    return (now.astimezone(zone) if now else datetime.now(zone)).date()


def effective_next_check(
    next_check: date | None,
    check_every: Interval | None,
    last_service: date | None,
    purchased: date | None,
) -> tuple[date | None, bool]:
    """Explicit `next_check` wins. Otherwise, with `check_every`, the next check is due one
    interval after the last maintenance-log entry, or after `purchased` if there is none."""
    if next_check is not None:
        return next_check, False
    base = last_service or purchased
    if check_every is not None and base is not None:
        return check_every.add_to(base), True
    return None, False


def compute_status(
    today: date,
    *,
    next_check: date | None = None,
    warranty_until: date | None = None,
    check_every: Interval | None = None,
    last_service: date | None = None,
    purchased: date | None = None,
) -> Status:
    check = warranty = None
    level: Level | None = None

    due, derived = effective_next_check(next_check, check_every, last_service, purchased)
    if due is not None:
        days = (due - today).days
        state = "overdue" if days < 0 else "due_soon" if days <= DUE_SOON_DAYS else "scheduled"
        check = CheckStatus(state=state, date=due, days=days, derived=derived)
        if state != "scheduled":
            level = state

    if warranty_until is not None:
        days = (warranty_until - today).days
        state = "expired" if days < 0 else "ending" if days <= WARRANTY_ENDING_DAYS else "active"
        warranty = WarrantyStatus(state=state, date=warranty_until, days=days)
        if state == "ending" and level is None:
            level = "warranty_ending"

    return Status(level=level, check=check, warranty=warranty)


def is_due_within(status: Status, days: int) -> bool:
    """`GET /api/items?due=N`: check due within N days (overdue included) or warranty ending
    within N days (expired warranties excluded)."""
    if status.check and status.check.days <= days:
        return True
    return bool(status.warranty and 0 <= status.warranty.days <= days)


def due_sort_key(status: Status, days: int) -> tuple[int, date]:
    """Order for `?due=N`: overdue first, then the soonest date that made the item qualify.
    An expired warranty never counts, so it can't pull an item forward."""
    dates = []
    if status.check and status.check.days <= days:
        dates.append(status.check.date)
    if status.warranty and 0 <= status.warranty.days <= days:
        dates.append(status.warranty.date)
    overdue = status.check is not None and status.check.state == "overdue"
    return (0 if overdue else 1, min(dates, default=date.max))
