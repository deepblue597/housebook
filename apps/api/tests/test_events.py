"""GET /api/events (DESIGN 15.7) through the real ASGI stack (middlewares included)."""

import json
import time
from collections.abc import Iterator
from pathlib import Path

from fastapi.testclient import TestClient

from conftest import ClientFactory

DISH = "it_7f3k2a"


def frames(lines: Iterator[str]) -> Iterator[tuple[str, object]]:
    """(event, data) per SSE frame; comments (none expected) come out as ("comment", text)."""
    event, data = None, None
    for line in lines:
        if line.startswith(":"):
            yield "comment", line[1:].strip()
        elif line.startswith("event: "):
            event = line.removeprefix("event: ")
        elif line.startswith("data: "):
            data = json.loads(line.removeprefix("data: "))
        elif line.startswith("retry: "):
            yield "retry", int(line.removeprefix("retry: "))
        elif line == "" and event:
            yield event, data
            event, data = None, None


def test_stream_headers_and_resync_first(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root)  # viewers may listen
    snap = c.get("/api/snapshot").json()
    with c.stream("GET", "/api/events", headers={"Accept-Encoding": "gzip"}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache" and r.headers["x-accel-buffering"] == "no"
        assert "content-encoding" not in r.headers  # never gzip an event stream
        it = frames(r.iter_lines())
        assert next(it) == ("retry", 5000)
        assert next(it) == (
            "resync",
            {
                "houseEtag": snap["houseEtag"],
                "houseReadOnly": False,
                "itemsVersion": snap["itemsVersion"],
                "texturesVersion": snap["texturesVersion"],
                "problemCount": snap["problemCount"],
            },
        )


def test_heartbeat_is_a_real_event(example_root: Path, make_client: ClientFactory):
    """EventSource hides `: comments`; a `ping` event lets the client run a watchdog."""
    c = make_client(example_root, sse_heartbeat=0.05)
    with c.stream("GET", "/api/events") as r:
        raw = r.iter_lines()
        it = frames(raw)
        assert [next(it)[0] for _ in range(2)] == ["retry", "resync"]
        assert next(it) == ("ping", {}) and next(it) == ("ping", {})


def test_shutdown_ends_open_streams(example_root: Path, make_client: ClientFactory):
    from housebook.api.app import close_streams

    c = make_client(example_root)
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        assert [next(it)[0] for _ in range(2)] == ["retry", "resync"]
        close_streams(c.app)  # what the SIGTERM handler does
        assert list(it) == []  # the stream ends
    with c.stream("GET", "/api/events") as r:  # and new ones end at once
        assert list(frames(r.iter_lines())) == []


def test_writes_reach_other_clients_with_the_new_etag(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, anon_role="editor")
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        assert [next(it)[0] for _ in range(2)] == ["retry", "resync"]

        r1 = c.post(f"/api/items/{DISH}/log", json={"text": "Descaled"})
        assert next(it) == (
            "item.changed",
            {
                "id": DISH,
                "etag": r1.json()["etag"],
                "path": "House/Kitchen/Dishwasher.md",
                "stale": False,
                "attachmentsEtag": r1.json()["attachmentsEtag"],
            },
        )

        h = c.get("/api/house")
        data = h.json()
        data["grid"]["width"] = 17
        r2 = c.put("/api/house", json=data, headers={"If-Match": h.headers["etag"]})
        assert next(it) == ("house.changed", {"etag": r2.headers["etag"].strip('"'), "readOnly": False})

        r3 = c.post("/api/items", json={"type": "fridge", "roomId": "rm_kit"})
        ev, payload = next(it)
        assert ev == "item.changed" and payload["id"] == r3.json()["id"]  # type: ignore[index]

        c.delete(f"/api/items/{r3.json()['id']}", headers={"If-Match": r3.headers["etag"]})
        assert next(it) == ("item.deleted", {"id": r3.json()["id"]})


def test_problems_changed_and_resync_reflects_it(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, anon_role="editor")
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        [next(it) for _ in range(2)]
        etag = c.get(f"/api/items/{DISH}").headers["etag"]
        c.delete(f"/api/items/{DISH}", headers={"If-Match": etag})  # its placement stays: missing note
        got = dict([next(it), next(it)])
        assert got["item.deleted"] == {"id": DISH} and got["problems.changed"] == {"count": 1}
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        next(it)
        assert next(it)[1]["problemCount"] == 1  # type: ignore[index]


def test_disconnect_unregisters(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root)
    hub = c.app.state.ctx.hub
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())  # keep a reference: closing the iterator closes the stream
        next(it)
        assert len(hub) == 1
    for _ in range(100):
        if len(hub) == 0:
            break
        time.sleep(0.01)
    assert len(hub) == 0


def test_events_follow_auth(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, auth_mode="proxy", trusted_proxies=())
    assert c.get("/api/events").status_code == 401  # EventSource can't see this; the client calls /api/me


def test_snapshot_carries_items_version(client: TestClient):
    snap = client.get("/api/snapshot").json()
    assert isinstance(snap["itemsVersion"], str) and len(snap["itemsVersion"]) == 32


def _until(it: Iterator[tuple[str, object]], event: str, limit: int = 200) -> object:
    for _ in range(limit):  # ping events (every 50 ms) keep this from blocking forever
        name, data = next(it)
        if name == event:
            return data
    raise AssertionError(f"no {event}")


def test_app_watcher_reports_external_edits(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, watch="inotify", sse_heartbeat=0.05)
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        _until(it, "resync")
        time.sleep(0.2)  # the watcher registers during startup; give it a moment
        path = example_root / "House/Kitchen/Dishwasher.md"
        path.write_text(path.read_text().replace("Add salt", "Add more salt"))  # saved in Obsidian
        data = _until(it, "item.changed")
        assert data["id"] == DISH  # type: ignore[index]
        assert data["etag"] == c.get(f"/api/items/{DISH}").json()["etag"]  # type: ignore[index]


def test_app_poll_mode_reports_external_edits(example_root: Path, make_client: ClientFactory):
    c = make_client(example_root, watch="poll", poll_interval=0.1, sse_heartbeat=0.05)
    with c.stream("GET", "/api/events") as r:
        it = frames(r.iter_lines())
        _until(it, "resync")
        (example_root / "House/Kitchen/Fridge.md").unlink()
        c.app.state.ctx.sync.delete_grace = 0.1
        assert _until(it, "item.deleted")["id"].startswith("it_")  # type: ignore[index]


def test_head_does_not_hang(client: TestClient):
    r = client.head("/api/events")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream") and r.content == b""


def test_snapshot_items_carry_attachments_etag(client: TestClient):
    items = {i["id"]: i for i in client.get("/api/snapshot").json()["items"]}
    assert len(items[DISH]["attachmentsEtag"]) == 16
    assert client.get(f"/api/items/{DISH}").json()["attachmentsEtag"] == items[DISH]["attachmentsEtag"]
