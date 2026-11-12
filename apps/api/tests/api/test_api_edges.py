"""Tester suite, in-process: edge cases and regressions not covered by tests/test_api.py.

Known bugs are reproduced as strict xfails tagged with their id (HB-xx) so they flip to
XPASS (and fail the run) once fixed; then drop the marker.
"""

import ipaddress
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import vault_builders as vb
from housebook.api.app import create_app
from housebook.config import ConfigError, Settings

REPO = Path(__file__).resolve().parents[4]
CONTRACT = REPO / "contract"


@pytest.fixture
def client_at():
    clients: list[TestClient] = []

    def factory(root: Path, now: datetime) -> TestClient:
        settings = Settings(data_dir=root, tz="Europe/Athens", contract_dir=CONTRACT, rescan_interval=0, watch="off")
        c = TestClient(create_app(settings, clock=lambda: now))
        c.__enter__()
        clients.append(c)
        return c

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "data"


def problems(c: TestClient) -> list[tuple[str, str | None]]:
    return [(p["kind"], p.get("path")) for p in c.get("/api/problems").json()["problems"]]


# --- conditional GET -------------------------------------------------------------------------


def test_snapshot_etag_is_stable_across_rescans_without_changes(client: TestClient):
    e1 = client.get("/api/snapshot").headers["etag"]
    client.app.state.ctx.indexer.scan()
    r = client.get("/api/snapshot", headers={"If-None-Match": e1})
    assert r.status_code == 304 and r.headers["etag"] == e1 and r.content == b""


@pytest.mark.parametrize("header", ['W/"{e}"', '"x", "{e}"', '"{e}" , W/"y"', "*"])
def test_if_none_match_forms(client: TestClient, header: str):
    etag = client.get("/api/house").headers["etag"].strip('"')
    assert client.get("/api/house", headers={"If-None-Match": header.format(e=etag)}).status_code == 304


def test_unquoted_etag_does_not_match(client: TestClient):
    etag = client.get("/api/house").headers["etag"].strip('"')
    assert client.get("/api/house", headers={"If-None-Match": etag}).status_code == 200


def test_house_edit_changes_house_and_snapshot_etags(example_root: Path, make_client):
    c = make_client(example_root)
    h1, s1 = c.get("/api/house").headers["etag"], c.get("/api/snapshot").headers["etag"]
    data = json.loads((example_root / "house.json").read_text())
    data["rooms"][0]["name"] = "Lounge"
    (example_root / "house.json").write_text(json.dumps(data))
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/house", headers={"If-None-Match": h1}).status_code == 200
    assert c.get("/api/snapshot", headers={"If-None-Match": s1}).status_code == 200
    assert c.get("/api/house").json()["rooms"][0]["name"] == "Lounge"


def test_item_etag_is_content_hash_and_never_304(client: TestClient):
    r = client.get("/api/items/it_7f3k2a")
    etag = r.headers["etag"]
    assert etag.strip('"') == r.json()["etag"]
    assert client.get("/api/items/it_7f3k2a", headers={"If-None-Match": etag}).status_code == 200


@pytest.mark.parametrize("path", ["/healthz", "/readyz", "/api/house", "/api/snapshot", "/api/me"])
def test_head_is_supported(client: TestClient, path: str):
    assert client.head(path).status_code == 200


# --- 404s and validation -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "path, status",
    [
        ("/api/items/it_nope", 404),
        ("/api/items/IT_7F3K2A", 404),  # ids are case-sensitive
        ("/api/items/it_7f3k2a/attachments/nope.pdf", 404),
        ("/api/items/it_nope/attachments/manual.pdf", 404),
        ("/api/nope", 404),
        ("/api/items?due=-1", 422),
        ("/api/items?due=3651", 422),
        ("/api/items?due=abc", 422),
        ("/api/items?q=" + "x" * 201, 422),
    ],
)
def test_error_statuses(client: TestClient, path: str, status: int):
    r = client.get(path)
    assert r.status_code == status
    assert r.headers["content-type"].startswith("application/json")


def test_api_responses_are_not_cached(client: TestClient):
    for path in ["/api/me", "/api/problems", "/api/items", "/api/items/it_nope"]:
        assert client.get(path).headers["cache-control"] in ("no-store", "no-cache"), path


# --- search (DESIGN 15.9, contract §5) -----------------------------------------------------------


def test_search_tiers_order(root: Path, make_client):
    vb.build_search_tiers(root)
    ids = [i["id"] for i in make_client(root).get("/api/items", params={"q": "zx9"}).json()["items"]]
    # name (starts-with first), error code, model, room, body
    assert ids == ["it_name1", "it_name2", "it_code", "it_model", "it_room", "it_body"]


@pytest.mark.parametrize(
    "q, expected",
    [
        ("E15", ["it_7f3k2a"]),
        ("e15", ["it_7f3k2a"]),
        ("sms4hv", ["it_7f3k2a"]),
        ("ΘΕΡΜΟΣΙΦΩΝΑΣ", ["it_1w7e3h"]),
        ("θερμοσιφωνας", ["it_1w7e3h"]),
        ("θερμοσίφωνασ", ["it_1w7e3h"]),  # final sigma written as medial sigma
        ("zzzz", []),
    ],
)
def test_search_on_example(client: TestClient, q: str, expected: list[str]):
    assert [i["id"] for i in client.get("/api/items", params={"q": q}).json()["items"]] == expected


def test_greek_room_and_nfd_name_searchable(root: Path, make_client):
    import unicodedata

    vb.write_house(
        root,
        vb.house(
            rooms=[{"id": "r1", "name": "Κουζίνα", "color": "#000000"}],
            placements=[{"itemId": "it_gr", "floorId": "f1", "x": 0, "y": 0}],
        ),
    )
    vb.item(root, "it_gr", "type: fridge", rel=unicodedata.normalize("NFD", "House/Κουζίνα/Ψυγείο.md"))
    c = make_client(root)
    for q in ["ψυγειο", "ΨΥΓΕΊΟ", "κουζινα", "ΚΟΥΖΙΝΑ"]:
        assert [i["id"] for i in c.get("/api/items", params={"q": q}).json()["items"]] == ["it_gr"], q
    assert c.get("/api/items/it_gr").json()["name"] == "Ψυγείο"  # NFC display name


# --- due ----------------------------------------------------------------------------------------


def test_due_filter_membership(root: Path, make_client):
    vb.build_due(root)
    c = make_client(root)

    def ids(n: int) -> set[str]:
        return {i["id"] for i in c.get("/api/items", params={"due": n}).json()["items"]}

    assert ids(0) == {"d_overdue", "d_today"}
    assert ids(10) == {"d_overdue", "d_today", "d_warranty10"}
    assert ids(30) == {"d_overdue", "d_today", "d_warranty10", "d_expired_soon"}
    assert "d_far" in ids(365) and "d_wfar" not in ids(365)


def test_due_sorted_soonest_relevant_date_first(root: Path, make_client):
    vb.build_due(root)
    ids = [i["id"] for i in make_client(root).get("/api/items", params={"due": 30}).json()["items"]]
    assert ids == ["d_overdue", "d_today", "d_warranty10", "d_expired_soon"]


# --- status and HOUSEBOOK_TZ around midnight --------------------------------------------------------


@pytest.mark.parametrize(
    "now_utc, today, days, level",
    [
        # Athens is UTC+2 in November: 21:59:59Z = 23:59:59 local, 22:00Z = 00:00 next day
        (datetime(2026, 11, 4, 21, 59, 59, tzinfo=UTC), "2026-11-04", 0, "due_soon"),
        (datetime(2026, 11, 4, 22, 0, 0, tzinfo=UTC), "2026-11-05", -1, "overdue"),
    ],
)
def test_today_follows_housebook_tz_at_midnight(root: Path, client_at, now_utc, today, days, level):
    vb.write_house(root, vb.house())
    vb.item(root, "it_mid", "name: Midnight\nnext_check: 2026-11-04")
    c = client_at(root, now_utc)
    snap = c.get("/api/snapshot").json()
    assert snap["today"] == today and snap["timezone"] == "Europe/Athens"
    st = c.get("/api/items/it_mid").json()["status"]
    assert st["check"]["days"] == days and st["level"] == level


def test_snapshot_etag_changes_when_the_day_changes(root: Path):
    vb.write_house(root, vb.house())
    vb.item(root, "it_mid", "name: Midnight\nnext_check: 2026-11-04")
    now = {"t": datetime(2026, 11, 4, 21, 59, tzinfo=UTC)}
    settings = Settings(data_dir=root, tz="Europe/Athens", contract_dir=CONTRACT, rescan_interval=0, watch="off")
    c = TestClient(create_app(settings, clock=lambda: now["t"]))
    with c:
        e1 = c.get("/api/snapshot").headers["etag"]
        now["t"] = datetime(2026, 11, 4, 22, 1, tzinfo=UTC)
        r = c.get("/api/snapshot", headers={"If-None-Match": e1})
        assert r.status_code == 200 and r.json()["today"] == "2026-11-05"


@pytest.mark.parametrize(
    "fm, level, check_state, warranty_state",
    [
        ("next_check: 2026-11-03", "overdue", "overdue", None),
        ("next_check: 2026-12-04", "due_soon", "due_soon", None),  # day 30
        ("next_check: 2026-12-05", None, "scheduled", None),  # day 31
        ("warranty_until: 2027-01-03", "warranty_ending", None, "ending"),  # day 60
        ("warranty_until: 2027-01-04", None, None, "active"),  # day 61
        ("warranty_until: 2026-11-03", None, None, "expired"),
        ("warranty_until: 2026-11-10\nnext_check: 2026-11-20", "due_soon", "due_soon", "ending"),
        ("check_every: 6m\npurchased: 2026-05-04", "due_soon", "due_soon", None),  # derived = today
    ],
)
def test_status_levels(root: Path, make_client, fm, level, check_state, warranty_state):
    vb.write_house(root, vb.house())
    vb.item(root, "it_s", f"name: S\n{fm}")
    st = make_client(root).get("/api/items/it_s").json()["status"]
    assert st["level"] == level
    assert (st["check"] or {}).get("state") == check_state
    assert (st["warranty"] or {}).get("state") == warranty_state


def test_check_every_uses_last_log_entry(root: Path, make_client):
    vb.write_house(root, vb.house())
    body = "## Maintenance log\n- 2026-01-31 one\n- 2025-12-01 older\n"
    vb.item(root, "it_s", "name: S\ncheck_every: 1m\npurchased: 2020-01-01", body)
    check = make_client(root).get("/api/items/it_s").json()["status"]["check"]
    assert check == {"state": "overdue", "date": "2026-02-28", "days": -249, "derived": True}


# --- messy data -------------------------------------------------------------------------------------


def test_yaml_11_traps_stay_strings(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_y", "name: 0x1F\nserial: 0123\nmodel: no\nbrand: on\ncritical: no\npurchased: 2024-05-10")
    it = make_client(root).get("/api/items/it_y").json()
    assert it["name"] == "0x1F"
    assert (it["fields"]["serial"], it["fields"]["model"], it["fields"]["brand"]) == ("0123", "no", "on")
    assert it["fields"]["critical"] is False and it["frontmatter"]["critical"] == "no"


def test_last_good_kept_through_break_empty_and_recovery(root: Path, make_client):
    vb.write_house(root, vb.house(placements=[{"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0}]))
    path = vb.item(root, "it_a", "name: Good")
    c = make_client(root)
    rescan = c.app.state.ctx.indexer.scan
    for broken in ("---\nhousebook_id: it_a\nname: [x\n---\n", "", "---\nhousebook_id: it_a\nname: Half"):
        path.write_text(broken)
        rescan()
        it = c.get("/api/items/it_a").json()
        assert it["stale"] is True and it["name"] == "Good" and it["parseError"], broken
        assert ("note_parse_error", "House/it_a.md") in problems(c)
        assert ("missing_note", None) not in problems(c)
    path.write_text(vb.note("housebook_id: it_a\nname: Fixed"))
    rescan()
    it = c.get("/api/items/it_a").json()
    assert it["stale"] is False and it["name"] == "Fixed" and problems(c) == []


def test_new_broken_note_is_reported_not_indexed(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.write(root, "House/New.md", "---\nhousebook_id: it_new\nname: [x\n---\n")
    c = make_client(root)
    assert c.get("/api/items/it_new").status_code == 404
    assert problems(c) == [("note_parse_error", "House/New.md")]


QH = vb.note("housebook_id: it_x\nname: X", "## Quick help\n- **E1**: a\n")


@pytest.mark.parametrize(
    "content",
    [
        pytest.param(b"\xef\xbb\xbf" + vb.note("housebook_id: it_x\nname: X").encode(), id="bom"),
        pytest.param(QH.replace("\n", "\r\n").encode(), id="crlf"),
        pytest.param(QH.replace("\n", "\r").encode(), id="cr"),
        pytest.param(b"---\nhousebook_id: it_x\nname: X\n...\nbody", id="yaml-doc-end"),
        pytest.param(b"---  \nhousebook_id: it_x\nname: X\n---\t\n", id="trailing-ws-fences"),
    ],
)
def test_encodings_and_fences(root: Path, make_client, content: bytes):
    vb.write_house(root, vb.house())
    vb.write(root, "House/X.md", content)
    c = make_client(root)
    r = c.get("/api/items/it_x")
    assert r.status_code == 200 and r.json()["name"] == "X"
    assert "\r" not in r.json()["body"]


def test_conflict_copies_never_win(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.write(root, "House/A.md", vb.note("housebook_id: it_a\nname: Real"), mtime=2_000_000_000)
    vb.write(root, "House/A.sync-conflict-20260101-120000-ABCDEFG.md", vb.note("housebook_id: it_a\nname: SC"), mtime=1)
    vb.write(root, "House/A (conflicted copy 2026-01-01 laptop).md", vb.note("housebook_id: it_a\nname: NC"), mtime=1)
    c = make_client(root)
    assert c.get("/api/items/it_a").json()["name"] == "Real"
    ps = c.get("/api/problems").json()["problems"]
    assert sorted(p["kind"] for p in ps) == ["conflict_copy", "conflict_copy"]
    assert all(p["detail"] == {"canonical": "House/A.md"} and p["itemId"] == "it_a" for p in ps)


def test_canonical_path_is_sticky_across_rescans(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.write(root, "House/B.md", vb.note("housebook_id: it_a\nname: B"), mtime=1000)
    c = make_client(root)
    # A newer-looking-older duplicate appears later: the indexed path stays canonical.
    vb.write(root, "House/A.md", vb.note("housebook_id: it_a\nname: A"), mtime=10)
    c.app.state.ctx.indexer.scan()
    assert c.get("/api/items/it_a").json()["path"] == "House/B.md"
    assert [p["kind"] for p in c.get("/api/problems").json()["problems"]] == ["duplicate_id"]


def test_notes_outside_notes_folder_ignored(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_out", "name: Out\ntags: housebook", rel="Other/Out.md")
    vb.item(root, "it_case", "name: Case", rel="house/Lower.md")  # case-sensitive folder name
    c = make_client(root)
    assert c.get("/api/items").json()["count"] == 0 and problems(c) == []


@pytest.mark.parametrize("name", ["Zero.md", "Spaces.md"])
def test_empty_new_files_are_silent(root: Path, make_client, name: str):
    vb.write_house(root, vb.house())
    vb.write(root, f"House/{name}", b"" if name == "Zero.md" else b"  \n\n")
    assert problems(make_client(root)) == []


def test_unicode_garbage_does_not_500(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.write(root, "House/Bin.md", os.urandom(4096))
    vb.write(root, "House/Nul.md", b"---\nhousebook_id: it_nul\nname: a\x00b\n---\n")
    vb.write(root, "House/Map.md", b"---\nhousebook_id: it_m\nname: {a: 1}\nmodel: [1, 2]\n---\n")
    c = make_client(root)
    for path in ["/api/snapshot", "/api/items", "/api/problems", "/api/items/it_m"]:
        assert c.get(path).status_code in (200, 404), path


def test_deeply_nested_yaml_note_is_a_problem_not_a_crash(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_ok", "name: Fine")
    vb.item(root, "it_deep", "name: Deep\nx: " + "[" * 5000 + "]" * 5000)
    c = make_client(root)  # raises RecursionError today
    assert c.get("/api/items/it_ok").status_code == 200
    assert ("note_parse_error", "House/it_deep.md") in problems(c)


def test_deeply_nested_house_json_is_house_invalid(root: Path, make_client):
    vb.write_house(root, "[" * 100_000 + "]" * 100_000)
    c = make_client(root)
    assert ("house_invalid", "house.json") in problems(c)


def test_yaml_alias_expansion_is_bounded(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_bomb", "name: Bomb\n" + vb.alias_bomb(levels=5))  # ~600 bytes on disk
    r = make_client(root).get("/api/snapshot")
    assert len(r.content) < 200_000, f"snapshot is {len(r.content)} bytes"


def test_unreadable_note_is_reported(root: Path, make_client):
    if os.geteuid() == 0:
        pytest.skip("root ignores file permissions")
    vb.write_house(root, vb.house(placements=[{"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0}]))
    path = vb.item(root, "it_a", "name: A")
    c = make_client(root)
    path.chmod(0)
    try:
        c.app.state.ctx.indexer.scan()
        kinds = problems(c)
        assert any(p == "House/it_a.md" for _, p in kinds), kinds
    finally:
        path.chmod(0o644)


# --- house.json variants ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides, kinds",
    [
        (
            {"rooms": [{"id": "r1", "name": "A", "color": "#000000"}, {"id": "r1", "name": "B", "color": "#111111"}]},
            ["house_duplicate_id"],
        ),
        (
            {
                "placements": [
                    {"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0},
                    {"itemId": "it_a", "floorId": "f1", "x": 1, "y": 1},
                ]
            },
            ["house_duplicate_placement"],
        ),
        ({"floors": [{"id": "f1", "name": "G", "cells": {"9,9": "r1"}}]}, ["house_outside_grid"]),
        ({"floors": [{"id": "f1", "name": "G", "cells": {"1,0": "gone"}}]}, ["house_unknown_room"]),
        ({"floors": [{"id": "f1", "name": "G", "cells": {"01,0": "r1"}}]}, ["house_bad_cell"]),
        ({"placements": [{"itemId": "it_a", "floorId": "nope", "x": 0, "y": 0}]}, ["house_unknown_floor"]),
        ({"placements": [{"itemId": "it_a", "floorId": "f1", "x": 4, "y": 0}]}, ["house_outside_grid"]),
        (
            {
                "openings": [
                    {"floorId": "f1", "x": 4, "y": 0, "side": "w", "kind": "door"},
                    {"floorId": "f1", "x": 0, "y": 3, "side": "n", "kind": "window"},
                ]
            },
            [],
        ),
        ({"openings": [{"floorId": "f1", "x": 4, "y": 0, "side": "n", "kind": "door"}]}, ["house_outside_grid"]),
    ],
)
def test_semantic_house_issues_become_problems(root: Path, make_client, overrides, kinds):
    vb.write_house(root, vb.house(**overrides))
    vb.item(root, "it_a", "name: A")
    c = make_client(root)
    assert c.get("/api/house").status_code == 200
    assert sorted(k for k, _ in problems(c)) == kinds


def test_newer_schema_version_read_only_everywhere(root: Path, make_client):
    vb.write_house(root, vb.house(schemaVersion=3, futureField={"x": 1}))
    c = make_client(root)
    r = c.get("/api/house")
    assert r.headers["x-housebook-read-only"] == "true" and "futureField" not in r.json()
    snap = c.get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["houseSchemaVersion"] == 3
    assert ("house_newer_version", "house.json") in problems(c)


def test_newer_schema_version_unparseable_still_read_only(root: Path, make_client):
    vb.write_house(root, vb.house(schemaVersion=3, grid={"cols": 16, "rows": 10}))
    snap = make_client(root).get("/api/snapshot").json()
    assert snap["houseReadOnly"] is True and snap["houseSchemaVersion"] == 3


# --- attachments -----------------------------------------------------------------------------------


def test_attachment_headers_by_type(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", "name: A")
    for name, data in {
        "m.pdf": vb.PDF,
        "p.PNG": b"\x89PNG\r\n\x1a\n",
        "x.svg": b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        "x.html": b"<script>alert(1)</script>",
        "x.xhtml": b"<html xmlns='http://www.w3.org/1999/xhtml'><script>alert(1)</script></html>",
        "x.js": b"alert(1)",
        "noext": b"<script>alert(1)</script>",
        "fake.pdf.html": b"<script>alert(1)</script>",
    }.items():
        vb.write(root, f"House/it_a/{name}", data)
    c = make_client(root)
    for name in ["x.svg", "x.html", "x.xhtml", "x.js", "noext", "fake.pdf.html"]:
        r = c.get(f"/api/items/it_a/attachments/{name}")
        assert r.status_code == 200, name
        assert r.headers["content-type"] == "application/octet-stream", name
        assert r.headers["content-disposition"].startswith("attachment;"), name
        assert r.headers["content-security-policy"] == "default-src 'none'; sandbox", name
        assert r.headers["x-content-type-options"] == "nosniff", name
    r = c.get("/api/items/it_a/attachments/p.PNG")
    assert r.headers["content-type"] == "image/png" and "sandbox" in r.headers["content-security-policy"]
    r = c.get("/api/items/it_a/attachments/m.pdf", headers={"Range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"%PDF" and r.headers["content-range"].endswith(f"/{len(vb.PDF)}")
    assert c.get("/api/items/it_a/attachments/m.pdf", headers={"Range": "bytes=9999-"}).status_code == 416


def test_attachment_links_escaping_root(tmp_path: Path, root: Path, make_client):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF secret")
    vb.write_house(root, vb.house())
    links = [
        "[[../../outside/secret.pdf]]",
        "..\\..\\outside\\secret.pdf",
        "/../outside/secret.pdf",
        "[[it_a/link.pdf]]",
    ]
    vb.item(root, "it_a", "name: A\nattachments: " + json.dumps(links))
    (root / "House/it_a").mkdir(parents=True)
    (root / "House/it_a/link.pdf").symlink_to(outside / "secret.pdf")
    c = make_client(root)
    assert c.get("/api/items/it_a").json()["attachments"] == []
    kinds = [k for k, _ in problems(c)]
    assert kinds.count("attachment_unsafe") == 4 and "symlink_outside_root" in kinds
    assert c.get("/api/items/it_a/attachments/secret.pdf").status_code == 404
    assert c.get("/api/items/it_a/attachments/link.pdf").status_code == 404


def test_bare_link_to_escaping_symlink_is_unsafe(tmp_path: Path, root: Path, make_client):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF")
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", 'name: A\nattachments: ["[[link.pdf]]"]')
    (root / "House/it_a").mkdir(parents=True)
    (root / "House/it_a/link.pdf").symlink_to(outside / "secret.pdf")
    assert "attachment_unsafe" in [k for k, _ in problems(make_client(root))]


# --- auth -------------------------------------------------------------------------------------------


def test_none_mode_ignores_identity_headers(client: TestClient):
    h = {"X-Forwarded-User": "mallory", "X-Forwarded-Groups": "housebook-editors"}
    assert client.get("/api/me", headers=h).json() == {"user": None, "role": "viewer", "authMode": "none"}


@pytest.fixture
def proxy(example_root: Path, make_client):
    def factory(peer: str) -> TestClient:
        return make_client(
            example_root,
            client_host=peer,
            auth_mode="proxy",
            trusted_proxies=(ipaddress.ip_network("10.0.0.5/32"), ipaddress.ip_network("fd00::/64")),
        )

    return factory


@pytest.mark.parametrize(
    "groups, role",
    [
        ("housebook-editors", "editor"),
        ("/housebook-editors", "editor"),
        ("family, /housebook-editors", "editor"),
        ("housebook-editors-x", "viewer"),
        ("xhousebook-editors", "viewer"),
        ("", "viewer"),
    ],
)
def test_proxy_group_mapping(proxy, groups: str, role: str):
    r = proxy("10.0.0.5").get("/api/me", headers={"X-Forwarded-User": "u", "X-Forwarded-Groups": groups})
    assert r.json()["role"] == role


@pytest.mark.parametrize("peer", ["10.0.0.6", "127.0.0.1", "fd01::1", "testclient"])
def test_proxy_untrusted_peers_get_401_even_with_xff(proxy, peer: str):
    c = proxy(peer)
    h = {
        "X-Forwarded-User": "mallory",
        "X-Forwarded-Groups": "housebook-editors",
        "X-Forwarded-For": "10.0.0.5",
        "X-Real-IP": "10.0.0.5",
        "Forwarded": "for=10.0.0.5",
    }
    for path in [
        "/api/me",
        "/api/snapshot",
        "/api/house",
        "/api/items",
        "/api/problems",
        "/api/catalog",
        "/api/items/it_7f3k2a/attachments/manual.pdf",
    ]:
        assert c.get(path, headers=h).status_code == 401, path


def test_proxy_trusted_ipv6_peer(proxy):
    r = proxy("fd00::7").get("/api/me", headers={"X-Forwarded-User": "u"})
    assert r.json() == {"user": "u", "role": "viewer", "authMode": "proxy"}


def test_proxy_requires_user_header(proxy):
    c = proxy("10.0.0.5")
    assert c.get("/api/me", headers={"X-Forwarded-User": "   "}).status_code == 401
    assert c.get("/api/me", headers={"X-Forwarded-Groups": "housebook-editors"}).status_code == 401


def test_proxy_docs_need_auth(proxy):
    c = proxy("192.168.1.9")
    assert c.get("/api/openapi.json").status_code == 401
    assert c.get("/api/docs").status_code == 401


def test_proxy_mode_without_trusted_proxies_refuses():
    with pytest.raises(ConfigError):
        Settings.from_env({"HOUSEBOOK_AUTH_MODE": "proxy"})


@pytest.mark.parametrize(
    "env",
    [
        {"HOUSEBOOK_AUTH_MODE": "proxy", "HOUSEBOOK_TRUSTED_PROXIES": "not-an-ip"},
        {"HOUSEBOOK_AUTH_MODE": "oidc"},
        {"HOUSEBOOK_ANON_ROLE": "admin"},
        {"HOUSEBOOK_TZ": "Mars/Olympus"},
        {"HOUSEBOOK_NOTES_DIR": "../x"},
        {"HOUSEBOOK_WATCH": "fanotify"},
        {"HOUSEBOOK_PORT": "eighty"},
    ],
)
def test_bad_config_is_rejected(env):
    with pytest.raises(ConfigError):
        Settings.from_env(env)


def test_notes_dir_dot_is_supported_or_rejected(root: Path):
    vb.write_house(root, vb.house())
    vb.item(root, "it_a", "name: A", rel="A.md")
    env = {"HOUSEBOOK_NOTES_DIR": ".", "HOUSEBOOK_DATA_DIR": str(root), "HOUSEBOOK_CONTRACT_DIR": str(CONTRACT)}
    try:
        s = Settings.from_env({**env, "HOUSEBOOK_RESCAN_INTERVAL": "0"})
    except ConfigError:
        return  # rejecting it is a fine fix too
    with TestClient(create_app(s)) as c:
        assert c.get("/api/items").json()["count"] == 1
