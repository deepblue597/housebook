"""Change detection, fan-out and the file watcher (DESIGN 15.5, 15.7, D10).

`Sync` is driven directly on an asyncio loop over a real temp folder. Timings are shrunk
(delete grace, parse retry, watcher quiet window) so the suite stays fast; the logic is the same.
"""

import asyncio
import json
import os
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

import vault_builders as vb
from conftest import CONTRACT
from housebook.adapters.fs import FsHouseRepo, MarkdownNoteRepo
from housebook.config import Settings
from housebook.domain.catalog import Catalog
from housebook.services import sync as sync_mod
from housebook.services.indexer import Indexer, attachments_etag
from housebook.services.sync import QUEUE_SIZE, Hub, Subscriber, Sync, WatchFilter, resync_payload
from housebook.services.writer import Writer

GRACE = 0.15
RETRY = 0.15

Event = tuple[str, dict]


def drain(sub: Subscriber) -> list[Event]:
    out: list[Event] = []
    while not sub.queue.empty():
        frame = sub.queue.get_nowait()
        assert frame is not None
        name, data = frame.strip("\n").split("\n")
        out.append((name.removeprefix("event: "), json.loads(data.removeprefix("data: "))))
    return out


async def collect(sub: Subscriber, seconds: float) -> list[Event]:
    """Everything that arrives within `seconds`."""
    await asyncio.sleep(seconds)
    return drain(sub)


async def wait_for(sub: Subscriber, pred: Callable[[list[Event]], bool], timeout: float = 5.0) -> list[Event]:
    got: list[Event] = []
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        got += drain(sub)
        if pred(got):
            return got
        await asyncio.sleep(0.02)
    raise AssertionError(f"timed out; got {got}")


def kinds(events: list[Event]) -> list[str]:
    return [e[0] for e in events]


class Env:
    def __init__(self, root: Path, catalog: Catalog) -> None:
        self.root = root
        self.indexer = Indexer(FsHouseRepo(root), MarkdownNoteRepo(root, "House"), catalog)
        self.hub = Hub()
        self.sync = Sync(self.indexer, self.hub, delete_grace=GRACE, parse_retry=RETRY)
        self.writer = Writer(
            self.indexer.house_repo,
            self.indexer.notes,
            self.indexer,
            catalog,
            Settings(data_dir=root, contract_dir=CONTRACT),
            lambda: datetime.now(UTC),
        )
        self.sub: Subscriber

    async def start(self) -> None:
        await self.sync.rescan()  # first scan: announces nothing
        self.sub = self.hub.subscribe()


def run(root: Path, catalog: Catalog, body: Callable[[Env], Awaitable[None]]) -> None:
    async def main() -> None:
        env = Env(root, catalog)
        await env.start()
        try:
            await body(env)
        finally:
            env.sync.close()

    asyncio.run(main())


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "data"
    vb.write_house(r, vb.house(placements=[{"itemId": "it_a", "floorId": "f1", "x": 0, "y": 0, "rotation": 0}]))
    vb.item(r, "it_a", "name: A\ntype: fridge", "\n## Notes\nx\n", rel="House/A.md")
    vb.item(r, "it_b", "name: B", rel="House/B.md")
    return r


# --- Sync: diffing, grace, retry --------------------------------------------------------------------


def test_external_edit_is_one_item_changed_with_the_new_etag(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        vb.item(root, "it_a", "name: A2\ntype: fridge", rel="House/A.md")
        state = await env.sync.rescan()
        assert drain(env.sub) == [
            (
                "item.changed",
                {
                    "id": "it_a",
                    "etag": state.items["it_a"].hash,
                    "path": "House/A.md",
                    "stale": False,
                    "attachmentsEtag": attachments_etag(state.items["it_a"]),
                },
            )
        ]
        await env.sync.rescan()
        assert drain(env.sub) == []  # nothing changed, nothing sent

    run(root, catalog, body)


def test_app_writes_are_announced_once_and_never_echoed(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        _, state = await env.sync.write(lambda: env.writer.patch_item("it_a", "*", {"brand": "LG"}, None))
        assert drain(env.sub) == [
            (
                "item.changed",
                {
                    "id": "it_a",
                    "etag": state.items["it_a"].hash,
                    "path": "House/A.md",
                    "stale": False,
                    "attachmentsEtag": attachments_etag(state.items["it_a"]),
                },
            )
        ]
        await env.sync.rescan()  # what the watcher does when it sees our own write
        assert drain(env.sub) == []

    run(root, catalog, body)


def test_rename_as_delete_then_create_is_one_item_changed(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        os.rename(root / "House/A.md", root / "A.md.moving")  # Obsidian/Syncthing: delete ...
        await env.sync.rescan()
        assert drain(env.sub) == []  # held for the grace period
        os.rename(root / "A.md.moving", root / "House/Renamed.md")  # ... then create
        await env.sync.rescan()
        events = drain(env.sub)
        assert kinds(events) == ["item.changed"] and events[0][1]["path"] == "House/Renamed.md"
        assert await collect(env.sub, GRACE * 2) == []  # no late item.deleted

    run(root, catalog, body)


def test_rename_within_one_scan(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        os.rename(root / "House/A.md", root / "House/Moved.md")
        await env.sync.rescan()
        assert [(k, d["path"]) for k, d in drain(env.sub)] == [("item.changed", "House/Moved.md")]

    run(root, catalog, body)


def test_real_delete_is_announced_after_the_grace_period(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        (root / "House/B.md").unlink()
        await env.sync.rescan()
        assert drain(env.sub) == []
        events = await wait_for(env.sub, lambda e: "item.deleted" in kinds(e), timeout=GRACE * 10)
        assert ("item.deleted", {"id": "it_b"}) in events

    run(root, catalog, body)


def test_api_delete_is_announced_at_once(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        await env.sync.write(lambda: env.writer.delete_item("it_b", "*"), deleted=["it_b"])
        assert drain(env.sub) == [("item.deleted", {"id": "it_b"})]

    run(root, catalog, body)


def test_half_written_note_is_retried_before_it_is_flagged(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        good = (root / "House/A.md").read_bytes()
        (root / "House/A.md").write_text("---\nhousebook_id: it_a\nname: A")  # mid-save
        await env.sync.rescan()
        assert drain(env.sub) == []  # not flagged yet
        (root / "House/A.md").write_bytes(good)  # the save completes before the retry
        assert await collect(env.sub, RETRY * 3) == []  # retry found it fine: nothing to tell

    run(root, catalog, body)


def test_still_broken_after_the_retry_is_flagged(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        (root / "House/A.md").write_text("---\nhousebook_id: it_a\nname: [unclosed\n---\n")
        await env.sync.rescan()
        assert drain(env.sub) == []
        events = await wait_for(env.sub, lambda e: len(e) >= 2, timeout=RETRY * 10)
        assert sorted(kinds(events)) == ["item.changed", "problems.changed"]
        changed = next(d for k, d in events if k == "item.changed")
        assert changed["stale"] is True and changed["id"] == "it_a"  # last good version kept

    run(root, catalog, body)


def test_house_change_carries_the_new_etag(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        vb.write_house(root, vb.house(rooms=[{"id": "r1", "name": "Salon", "color": "#000000"}]))
        state = await env.sync.rescan()
        events = drain(env.sub)
        assert ("house.changed", {"etag": state.house.etag, "readOnly": False}) in events
        assert "item.changed" not in kinds(events)  # notes untouched; the client refetches the house
        assert resync_payload(state)["houseEtag"] == state.house.etag

    run(root, catalog, body)


def test_conflict_copy_is_a_problem_not_a_new_item(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        vb.item(root, "it_a", "name: A other device", rel="House/A.sync-conflict-20260101-120000-ABCDEFG.md")
        vb.item(root, "it_a", "name: A dropbox", rel="House/A (conflicted copy 2026-01-02).md")
        state = await env.sync.rescan()
        assert drain(env.sub) == [("problems.changed", {"count": len(state.problems)})]
        assert state.items["it_a"].rel == "House/A.md"
        assert sorted(p.kind for p in state.problems if p.item_id == "it_a") == ["conflict_copy", "conflict_copy"]

    run(root, catalog, body)


def test_attachment_added_changes_the_item(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        before = env.indexer.state.items["it_a"]  # type: ignore[union-attr]
        vb.write(root, "House/A/manual.pdf", vb.PDF)
        await env.sync.rescan()
        ((kind, data),) = drain(env.sub)
        # The note didn't change, so only attachmentsEtag tells the client to refetch.
        assert kind == "item.changed" and data["etag"] == before.hash and data["stale"] is False
        assert data["attachmentsEtag"] != attachments_etag(before)
        vb.write(root, "House/A/manual.pdf", vb.PDF + b"more")  # replaced, same name
        await env.sync.rescan()
        assert drain(env.sub)[0][1]["attachmentsEtag"] != data["attachmentsEtag"]

    run(root, catalog, body)


def test_items_version_tracks_the_index(root: Path, catalog: Catalog):
    async def body(env: Env) -> None:
        state = env.indexer.state
        assert state is not None
        v1 = resync_payload(state)["itemsVersion"]
        assert resync_payload(await env.sync.rescan())["itemsVersion"] == v1
        vb.item(root, "it_c", "name: C", rel="House/C.md")
        assert resync_payload(await env.sync.rescan())["itemsVersion"] != v1

    run(root, catalog, body)


def test_slow_clients_are_dropped():
    async def body() -> None:
        hub = Hub()
        slow, fast = hub.subscribe(), hub.subscribe()
        for i in range(QUEUE_SIZE):
            hub.publish("item.changed", {"i": i})
            fast.queue.get_nowait()
        assert len(hub) == 2
        hub.publish("item.changed", {"i": "overflow"})
        assert slow.dropped and not fast.dropped and len(hub) == 1

    asyncio.run(body())


# --- the watcher --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rel", "ignored"),
    [
        ("House/A.md", False),
        ("house.json", False),
        ("House/A/manual.pdf", False),
        (".housebook/history/house-1.json", True),
        (".housebook/lock", True),
        ("House/.obsidian/workspace.json", True),
        (".obsidian/app.json", True),
        (".trash/A.md", True),
        (".stfolder", True),
        (".stversions/House/A.md", True),
        ("House/.syncthing.A.md.tmp", True),
        ("House/~syncthing~A.md.tmp", True),
        ("House/A.md.tmp", True),
        ("House/.A.md.swp", True),
        ("House/A.md~", True),
        ("House/4913", True),
        ("House/.DS_Store", True),
        ("House/.~lock.A.md#", True),
        ("House/manual.pdf.crdownload", True),
        ("House/.A.md.1a2b3c4d.tmp", True),  # our own atomic-write temp file
    ],
)
def test_watch_filter(tmp_path: Path, rel: str, ignored: bool):
    f = WatchFilter(tmp_path)
    assert f(None, str(tmp_path / rel)) is (not ignored)
    assert f(None, str(tmp_path.parent / "elsewhere.md")) is False


@pytest.fixture
def fast_watch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sync_mod, "WATCH_STEP_MS", 100)
    monkeypatch.setattr(sync_mod, "WATCH_MAX_MS", 1000)


def run_watching(root: Path, catalog: Catalog, body: Callable[[Env], Awaitable[None]], mode: str = "inotify") -> None:
    async def wrapped(env: Env) -> None:
        stop = asyncio.Event()
        task = asyncio.create_task(sync_mod.watch(root, env.sync, mode, 0.05, stop))  # type: ignore[arg-type]
        await asyncio.sleep(0.2)  # let the watcher register
        try:
            await body(env)
        finally:
            stop.set()
            await asyncio.wait_for(task, 5)

    run(root, catalog, wrapped)


SETTLE = 0.4  # longer than the quiet window + a scan: no further events will come


def test_watch_burst_of_in_place_writes_is_one_event(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        for i in range(3):  # Obsidian-style autosaves in quick succession
            vb.item(root, "it_a", f"name: A{i}\ntype: fridge", rel="House/A.md")
        events = await wait_for(env.sub, lambda e: bool(e))
        events += await collect(env.sub, SETTLE)
        assert kinds(events) == ["item.changed"]
        assert events[0][1]["etag"] == env.indexer.state.items["it_a"].hash  # type: ignore[union-attr]

    run_watching(root, catalog, body)


def test_watch_syncthing_temp_file_and_rename(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        tmp = vb.item(root, "it_b", "name: B from phone", rel="House/.syncthing.B.md.tmp")
        assert await collect(env.sub, SETTLE) == []  # the temp file alone is ignored
        os.replace(tmp, root / "House/B.md")
        events = await wait_for(env.sub, lambda e: bool(e))
        events += await collect(env.sub, SETTLE)
        assert kinds(events) == ["item.changed"] and events[0][1]["id"] == "it_b"

    run_watching(root, catalog, body)


def test_watch_rename_is_item_changed_not_deleted(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        (root / "House/Kitchen").mkdir()
        os.rename(root / "House/A.md", root / "House/Kitchen/A.md")
        events = await wait_for(env.sub, lambda e: "item.changed" in kinds(e))
        events += await collect(env.sub, GRACE * 3)
        assert kinds(events) == ["item.changed"] and events[0][1]["path"] == "House/Kitchen/A.md"

    run_watching(root, catalog, body)


def test_watch_ignores_noise_and_suppresses_self_writes(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        vb.write(root, ".obsidian/workspace.json", "{}")
        vb.write(root, "House/A.md.swp", "x")
        vb.write(root, ".housebook/history/x.json", "{}")
        assert await collect(env.sub, SETTLE) == []
        await env.sync.write(lambda: env.writer.append_log("it_a", date(2026, 1, 1), "x"))
        assert kinds(drain(env.sub)) == ["item.changed"]  # from the write itself
        assert await collect(env.sub, SETTLE) == []  # the watcher saw the file; same hash: no echo

    run_watching(root, catalog, body)


def test_watch_conflict_copy(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        vb.item(root, "it_a", "name: other", rel="House/A.sync-conflict-20260101-120000-ABCDEFG.md")
        events = await wait_for(env.sub, lambda e: bool(e))
        events += await collect(env.sub, SETTLE)
        assert kinds(events) == ["problems.changed"]

    run_watching(root, catalog, body)


def test_watch_polling_mode(root: Path, catalog: Catalog, fast_watch: None):
    async def body(env: Env) -> None:
        vb.item(root, "it_b", "name: B polled", rel="House/B.md")
        events = await wait_for(env.sub, lambda e: bool(e))
        assert kinds(events) == ["item.changed"] and events[0][1]["id"] == "it_b"

    run_watching(root, catalog, body, mode="poll")
