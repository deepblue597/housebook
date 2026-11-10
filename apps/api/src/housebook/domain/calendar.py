"""The calendar feed (D40): items' next checks and warranty ends as an iCalendar file (RFC 5545).

Pure: the route gathers the items and passes plain events in. Every event is an all-day event
on its date, marked free time, with a UID that stays the same for the same item and kind, so a
calendar app moves the event when the date changes instead of adding a second one.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from housebook.domain.status import Status

PRODID = "-//Housebook//Housebook calendar//EN"
REFRESH = "PT6H"  # how often a calendar app should fetch again (a hint; Google ignores it)


@dataclass(frozen=True)
class CalendarEvent:
    uid: str
    day: date
    summary: str
    description: str
    url: str | None = None


@dataclass(frozen=True)
class CalendarItem:
    """What the feed needs to know about one item."""

    id: str
    name: str
    status: Status
    where: str | None  # "Kitchen · Ground floor"; None when unplaced
    what: str | None  # "Bosch SMS4HVI33E"
    every: str | None  # check_every as written, e.g. "6m"
    url: str | None  # link to the item in the app


def item_events(item: CalendarItem) -> list[CalendarEvent]:
    """A "Check" event on the next check date (explicit or from `check_every`) and a "Warranty
    ends" event on `warranty_until`, whatever their state: past dates stay where they were."""
    out: list[CalendarEvent] = []
    lines = [x for x in (item.where, item.what) if x]

    def event(kind: Literal["check", "warranty"], day: date, summary: str, extra: list[str]) -> CalendarEvent:
        description = "\n".join([*lines, *extra, *([item.url] if item.url else [])])
        return CalendarEvent(f"{item.id}-{kind}@housebook", day, summary, description, item.url)

    check = item.status.check
    if check:
        extra = []
        if check.derived and item.every:
            extra.append(f"Every {item.every}, counted from the maintenance log or the purchase date.")
        out.append(event("check", check.date, f"Check: {item.name}", extra))
    warranty = item.status.warranty
    if warranty:
        out.append(event("warranty", warranty.date, f"Warranty ends: {item.name}", []))
    return out


def _escape(text: str) -> str:
    """TEXT values (RFC 5545 3.3.11)."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
    )


def _fold(line: str) -> str:
    """Lines longer than 75 octets continue on the next line after CRLF + space (3.1), never
    splitting a UTF-8 character."""
    out: list[str] = []
    current = ""
    size = 0
    limit = 75
    for ch in line:
        n = len(ch.encode("utf-8"))
        if size + n > limit:
            out.append(current)
            current, size, limit = " ", 1, 75
        current += ch
        size += n
    out.append(current)
    return "\r\n".join(out)


def _day(d: date) -> str:
    return d.strftime("%Y%m%d")


def calendar_ics(events: Iterable[CalendarEvent], *, name: str, stamp: datetime) -> str:
    """The whole feed. `stamp` (UTC) is DTSTAMP for every event: when the feed was made."""
    dtstamp = stamp.strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape(name)}",
        f"REFRESH-INTERVAL;VALUE=DURATION:{REFRESH}",
        f"X-PUBLISHED-TTL:{REFRESH}",
    ]
    for e in sorted(events, key=lambda e: (e.day, e.uid)):
        lines += [
            "BEGIN:VEVENT",
            f"UID:{e.uid}",
            f"DTSTAMP:{dtstamp}",
            f"DTSTART;VALUE=DATE:{_day(e.day)}",
            f"DTEND;VALUE=DATE:{_day(e.day + timedelta(days=1))}",
            f"SUMMARY:{_escape(e.summary)}",
            f"DESCRIPTION:{_escape(e.description)}",
            *([f"URL:{e.url}"] if e.url else []),
            "TRANSP:TRANSPARENT",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "".join(_fold(line) + "\r\n" for line in lines)
