"""Calendar feed and links (milestone 8, D40)."""

import ipaddress
import json
import logging
from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import ClientFactory
from housebook.domain.calendar import CalendarEvent, CalendarItem, calendar_ics, item_events
from housebook.domain.status import CheckStatus, Status, WarrantyStatus
from housebook.log import RedactTokens

DISHWASHER = "it_7f3k2a"  # warranty_until 2027-05-10
WATER_HEATER = "it_1w7e3h"  # next_check 2027-03-01, every 2y
ORIGIN = "https://house.example"
JSON = {"Origin": ORIGIN, "Content-Type": "application/json"}

STAMP = datetime(2026, 11, 4, 10, 0, tzinfo=UTC)


def unfold(ics: str) -> list[str]:
    assert ics.endswith("\r\n")
    assert "\n" not in ics.replace("\r\n", "")  # only CRLF line ends
    return ics.replace("\r\n ", "").split("\r\n")[:-1]


def events_of(ics: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for line in unfold(ics):
        if line == "BEGIN:VEVENT":
            out.append({})
        elif out and line != "END:VEVENT" and ":" in line and "BEGIN:" not in line:
            key, _, value = line.partition(":")
            out[-1].setdefault(key, value)
    return out


# --- the file format --------------------------------------------------------------------------


def test_all_day_events_free_time_stable_uid():
    ics = calendar_ics(
        [CalendarEvent("it_a-check@housebook", date(2026, 12, 31), "Check: Boiler", "Kitchen")],
        name="Housebook",
        stamp=STAMP,
    )
    lines = unfold(ics)
    assert lines[:3] == ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Housebook//Housebook calendar//EN"]
    assert "X-WR-CALNAME:Housebook" in lines and lines[-1] == "END:VCALENDAR"
    [e] = events_of(ics)
    assert e["UID"] == "it_a-check@housebook"
    assert e["DTSTAMP"] == "20261104T100000Z"
    assert e["DTSTART;VALUE=DATE"] == "20261231"
    assert e["DTEND;VALUE=DATE"] == "20270101"  # exclusive end: the next day
    assert e["TRANSP"] == "TRANSPARENT"


def test_text_is_escaped_and_long_lines_folded_without_splitting_characters():
    summary = "Check: Θερμοσίφωνας, μπάνιο; καθαρισμός \\ " + "λ" * 60
    ics = calendar_ics(
        [CalendarEvent("u@housebook", date(2027, 1, 1), summary, "Line one\nLine two")],
        name="Housebook",
        stamp=STAMP,
    )
    for raw in ics.split("\r\n"):
        assert len(raw.encode("utf-8")) <= 75
        raw.encode("utf-8").decode("utf-8")  # every physical line is whole UTF-8
    [e] = events_of(ics)
    assert e["SUMMARY"] == summary.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;")
    assert e["DESCRIPTION"] == "Line one\\nLine two"


def test_item_events_check_and_warranty_whatever_their_state():
    status = Status(
        level="overdue",
        check=CheckStatus(state="overdue", date=date(2026, 10, 1), days=-34, derived=True),
        warranty=WarrantyStatus(state="expired", date=date(2025, 1, 1), days=-672),
    )
    item = CalendarItem(
        id="it_x",
        name="Boiler",
        status=status,
        where="Kitchen · Ground",
        what="Vaillant ecoTEC",
        every="1y",
        url="https://h/i/it_x",
    )
    check, warranty = item_events(item)
    assert (check.uid, check.day, check.summary) == ("it_x-check@housebook", date(2026, 10, 1), "Check: Boiler")
    assert check.description.split("\n") == [
        "Kitchen · Ground",
        "Vaillant ecoTEC",
        "Every 1y, counted from the maintenance log or the purchase date.",
        "https://h/i/it_x",
    ]
    assert (warranty.uid, warranty.summary) == ("it_x-warranty@housebook", "Warranty ends: Boiler")
    none = Status(level=None, check=None, warranty=None)
    assert item_events(CalendarItem("it_y", "Y", none, None, None, None, None)) == []


# --- links and the feed -----------------------------------------------------------------------


def make_link(c: TestClient, headers: dict[str, str] | None = None) -> str:
    r = c.post("/api/calendar/link", json={}, headers={**JSON, **(headers or {})})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["exists"] is True and body["createdAt"]
    assert body["url"].startswith(f"{ORIGIN}/api/calendar.ics?token=")
    return body["url"].removeprefix(ORIGIN)


def test_link_lifecycle_and_feed(client: TestClient, example_root: Path):
    assert client.get("/api/calendar/link").json() == {"exists": False, "createdAt": None, "url": None}
    path = make_link(client)
    token = path.split("token=")[1]
    # Only the hash is stored; the link can't be shown again.
    stored = (example_root / ".housebook" / "calendar-links.json").read_text()
    assert token not in stored and json.loads(stored)["links"][""]["origin"] == ORIGIN
    again = client.get("/api/calendar/link").json()
    assert again["exists"] is True and again["url"] is None

    r = client.get(path)
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/calendar; charset=utf-8"
    assert r.headers["cache-control"] == "private, no-cache"
    events = {e["SUMMARY"]: e for e in events_of(r.text)}
    dish = events["Warranty ends: Dishwasher"]
    assert dish["DTSTART;VALUE=DATE"] == "20270510"
    assert dish["URL"] == f"{ORIGIN}/i/{DISHWASHER}"
    assert "Kitchen · Apartment" in dish["DESCRIPTION"]
    assert events["Check: Water heater"]["DTSTART;VALUE=DATE"] == "20270301"

    # Same data: 304 with the same ETag.
    etag = r.headers["etag"]
    assert client.get(path, headers={"If-None-Match": etag}).status_code == 304

    # A new link replaces the old one.
    newer = make_link(client)
    assert client.get(path).status_code == 404
    assert client.get(newer).status_code == 200
    # Turned off: gone.
    assert client.delete("/api/calendar/link").status_code == 204
    assert client.get(newer).status_code == 404
    assert client.get("/api/calendar/link").json()["exists"] is False


@pytest.mark.parametrize("query", ["", "?token=", "?token=nope", "?token=" + "x" * 500])
def test_unknown_codes_are_404(client: TestClient, query: str):
    make_link(client)
    assert client.get(f"/api/calendar.ics{query}").status_code == 404


def test_making_a_link_needs_a_json_body(client: TestClient):
    r = client.post("/api/calendar/link", content=b"", headers={"Origin": ORIGIN})
    assert r.status_code == 415
    r = client.post(
        "/api/calendar/link",
        content=b"a=1",
        headers={"Origin": ORIGIN, "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 415


def test_without_an_origin_header_the_link_uses_the_request_url(client: TestClient):
    r = client.post("/api/calendar/link", json={}, headers={"Origin": "javascript:alert(1)"})
    assert r.status_code == 201
    assert r.json()["url"].startswith("http://testserver/api/calendar.ics?token=")


def test_viewers_make_their_own_link_but_still_cannot_edit(example_root: Path, make_client: ClientFactory):
    viewer = make_client(example_root, anon_role="viewer")
    path = make_link(viewer)
    assert viewer.get(path).status_code == 200
    assert viewer.delete("/api/calendar/link").status_code == 204
    r = viewer.patch(f"/api/items/{DISHWASHER}", json={}, headers={"If-Match": "*"})
    assert r.status_code == 403


@pytest.fixture
def proxied(example_root: Path, make_client: ClientFactory):
    def factory(client_host: str) -> TestClient:
        return make_client(
            example_root,
            client_host=client_host,
            auth_mode="proxy",
            trusted_proxies=(ipaddress.ip_network("10.0.0.0/24"),),
        )

    return factory


def test_proxy_mode_one_link_per_person_and_the_feed_needs_no_login(proxied):
    c = proxied("10.0.0.7")
    ana = {"X-Forwarded-User": "ana", "X-Forwarded-Groups": "family"}
    ben = {"X-Forwarded-User": "ben", "X-Forwarded-Groups": "housebook-editors"}
    ana_path = make_link(c, ana)
    ben_path = make_link(c, ben)
    assert c.get("/api/calendar/link", headers=ana).json()["exists"] is True
    # Ben turning his off leaves Ana's working.
    assert c.delete("/api/calendar/link", headers=ben).status_code == 204
    assert c.get(ben_path).status_code == 404
    # The feed is fetched by a calendar app: no identity headers, maybe from anywhere. Same app,
    # another peer (not entered: the app is already running).
    outside = TestClient(c.app, client=("203.0.113.9", 50000))
    assert outside.get(ana_path).status_code == 200
    # Managing links still needs the login.
    assert outside.get("/api/calendar/link").status_code == 401
    assert outside.post("/api/calendar/link", json={}, headers=JSON).status_code == 401


def test_a_broken_links_file_disables_links_without_breaking_the_app(client: TestClient, example_root: Path):
    path = make_link(client)
    (example_root / ".housebook" / "calendar-links.json").write_text("{not json")
    assert client.get(path).status_code == 404
    assert client.get("/api/calendar/link").json()["exists"] is False
    assert client.get("/api/snapshot").status_code == 200
    assert client.get(make_link(client)).status_code == 200  # a new link fixes it


def test_codes_are_redacted_from_logs():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s - "%s %s HTTP/%s" %d',
        ("1.2.3.4:5", "GET", "/api/calendar.ics?token=s3cr3t&x=1", "1.1", 200),
        None,
    )
    RedactTokens().filter(record)
    assert "s3cr3t" not in record.getMessage()
    assert "/api/calendar.ics?token=[redacted]&x=1" in record.getMessage()
