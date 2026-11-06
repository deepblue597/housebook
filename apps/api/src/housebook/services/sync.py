"""Change detection and fan-out (DESIGN 15.5, 15.7, D10).

Every change, whatever its source (an API write, the file watcher, the periodic rescan), runs
the same path under one lock: full scan -> diff against what clients were last told -> events.
A full scan of a few hundred notes takes milliseconds (unchanged files skip YAML parsing), so
there is no per-path index update to get wrong; the periodic rescan stays the correctness path.

- Self-write suppression by content hash: an API write rescans and announces immediately, so
  when the watcher reports the same file a moment later the index already holds that hash and
  the diff is empty. Nothing is time-window based, so a real external edit is never hidden.
- Delete grace: an item that disappears is announced as `item.deleted` only if it is still
  missing ~3 s later; a rename (delete + create, as Obsidian and Syncthing do it) becomes one
  `item.changed` with the new path. Deletes through the API are announced at once.
- Parse retry: a note that just became unparseable (usually half-written) is re-checked once
  after ~1 s before its `item.changed` / `problems.changed` go out.
- No event log and no Last-Event-ID replay: every (re)connect starts with `resync`.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import os
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from housebook.domain.paths import is_ignored_name
from housebook.domain.text import nfc
from housebook.services.indexer import Indexer, IndexState, attachments_etag

log = logging.getLogger(__name__)

QUEUE_SIZE = 64  # events buffered per SSE client before it counts as too slow and is dropped
DELETE_GRACE = 3.0
PARSE_RETRY = 1.0
WATCH_STEP_MS = 400  # quiet window: a batch is processed once no change arrived for this long
WATCH_MAX_MS = 2000  # ... or at the latest this long after its first change


# --- fan-out ---------------------------------------------------------------------------------------


def sse_frame(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


@dataclass(eq=False)
class Subscriber:
    queue: asyncio.Queue[str | None] = field(default_factory=lambda: asyncio.Queue(QUEUE_SIZE))
    dropped: bool = False


class Hub:
    """SSE clients. Only touched from the event loop."""

    def __init__(self) -> None:
        self._subs: set[Subscriber] = set()
        self.closed = False  # server shutting down: streams end, new ones end at once

    def __len__(self) -> int:
        return len(self._subs)

    def close_all(self) -> None:
        """End every stream (server shutdown). Without this uvicorn waits forever for them."""
        self.closed = True
        for sub in list(self._subs):
            sub.dropped = True
            with contextlib.suppress(asyncio.QueueFull):  # a full queue wakes its reader anyway
                sub.queue.put_nowait(None)
        self._subs.clear()

    def subscribe(self) -> Subscriber:
        sub = Subscriber()
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    def publish(self, event: str, data: dict[str, Any]) -> None:
        frame = sse_frame(event, data)
        for sub in list(self._subs):
            try:
                sub.queue.put_nowait(frame)
            except asyncio.QueueFull:
                # A phone in the background: drop it; EventSource reconnects and resyncs.
                sub.dropped = True
                self._subs.discard(sub)
                log.info("sse client dropped: queue full")
        log.debug("event", extra={"event": event, **data, "clients": len(self._subs)})


# --- what clients know -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ItemSig:
    etag: str
    path: str
    stale: bool
    attachments_etag: str


def item_sigs(state: IndexState) -> dict[str, ItemSig]:
    return {i: ItemSig(it.hash, nfc(it.rel), it.stale, attachments_etag(it)) for i, it in state.items.items()}


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def items_version(state: IndexState) -> str:
    """Version of the item index: changes whenever any item's etag, path, staleness or
    attachments change. Also in /api/snapshot as `itemsVersion`."""
    return _digest({i: [s.etag, s.path, s.stale, s.attachments_etag] for i, s in item_sigs(state).items()})


def problems_version(state: IndexState) -> str:
    return _digest([p.model_dump(mode="json") for p in state.problems])


def resync_payload(state: IndexState) -> dict[str, Any]:
    return {
        "houseEtag": state.house.etag,
        "houseReadOnly": state.house.read_only,
        "itemsVersion": items_version(state),
        "problemCount": len(state.problems),
    }


class Sync:
    def __init__(
        self, indexer: Indexer, hub: Hub, *, delete_grace: float = DELETE_GRACE, parse_retry: float = PARSE_RETRY
    ) -> None:
        self.indexer = indexer
        self.hub = hub
        self.delete_grace = delete_grace
        self.parse_retry = parse_retry
        self.lock = asyncio.Lock()  # one change at a time: writes, watcher batches, rescans
        self._items: dict[str, ItemSig] | None = None  # as last announced
        self._house: tuple[str | None, bool] | None = None
        self._problems: str | None = None
        self._pending_deletes: dict[str, float] = {}  # id -> loop time when it may be announced
        self._retrying: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()

    async def rescan(self, *, retry: bool = False) -> IndexState:
        async with self.lock:
            state = await asyncio.to_thread(self.indexer.scan)
            self._announce(state, retry=retry)
            return state

    async def write[T](self, fn: Callable[[], T], *, deleted: Iterable[str] = ()) -> tuple[T, IndexState]:
        """Run a blocking write, then rescan and announce. Errors flagged `refresh_index` (412,
        404: the disk is ahead of the index) rescan first, so the client's reload gets the
        current version; then the error is re-raised."""
        async with self.lock:
            try:
                result = await asyncio.to_thread(fn)
            except Exception as e:
                if getattr(e, "refresh_index", False):
                    self._announce(await asyncio.to_thread(self.indexer.scan))
                raise
            state = await asyncio.to_thread(self.indexer.scan)
            self._announce(state, deleted=set(deleted))
            return result, state

    def close(self) -> None:
        for t in self._tasks:
            t.cancel()

    def _spawn(self, coro: Any) -> None:
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _announce(
        self, state: IndexState, *, deleted: frozenset[str] | set[str] = frozenset(), retry: bool = False
    ) -> None:
        new = item_sigs(state)
        house = (state.house.etag, state.house.read_only)
        problems = problems_version(state)
        if self._items is None:  # first scan: nobody to tell yet
            self._items, self._house, self._problems = dict(new), house, problems
            return
        loop = asyncio.get_running_loop()
        now = loop.time()
        announced = self._items

        # Parse retry: hold back items that just turned unparseable until one re-check.
        if retry:
            self._retrying.clear()
        newly_stale = {i for i, s in new.items() if s.stale and not (i in announced and announced[i].stale)}
        if not retry:
            fresh = newly_stale - self._retrying
            if fresh:
                if not self._retrying:
                    self._spawn(self._retry_later())
                self._retrying |= fresh
        held = self._retrying & newly_stale

        events: list[tuple[str, dict[str, Any]]] = []
        if house != self._house:
            events.append(("house.changed", {"etag": house[0], "readOnly": house[1]}))
            self._house = house
        for item_id, sig in new.items():
            if item_id in held:
                continue
            self._pending_deletes.pop(item_id, None)
            if announced.get(item_id) != sig:
                payload = {"id": item_id, "etag": sig.etag, "path": sig.path, "stale": sig.stale}
                events.append(("item.changed", {**payload, "attachmentsEtag": sig.attachments_etag}))
                announced[item_id] = sig
        for item_id in [i for i in announced if i not in new]:
            due = self._pending_deletes.get(item_id)
            if item_id in deleted or (due is not None and due <= now):
                events.append(("item.deleted", {"id": item_id}))
                del announced[item_id]
                self._pending_deletes.pop(item_id, None)
            elif due is None:
                self._pending_deletes[item_id] = now + self.delete_grace
                loop.call_later(self.delete_grace + 0.01, lambda: self._spawn(self._flush()))
        # Problems wait too while an item is held: a rename must not flash "missing note".
        if problems != self._problems and not held and not self._pending_deletes:
            events.append(("problems.changed", {"count": len(state.problems)}))
            self._problems = problems
        for event, data in events:
            self.hub.publish(event, data)

    async def _retry_later(self) -> None:
        await asyncio.sleep(self.parse_retry)
        try:
            await self.rescan(retry=True)
        except Exception:
            log.exception("parse-retry rescan failed")

    async def _flush(self) -> None:
        """Re-diff the current index once a delete's grace period has passed (no rescan)."""
        async with self.lock:
            if self.indexer.state is not None:
                self._announce(self.indexer.state)


# --- file watcher ------------------------------------------------------------------------------------


class WatchFilter:
    """Only the data root; ignored names (dot-files/dirs such as .housebook, .obsidian, .trash,
    .stversions, .syncthing.*.tmp, our own .*.tmp; *.tmp, *.swp, *~, 4913, ~syncthing~*, ...)
    at any depth are dropped (DESIGN 15.5)."""

    def __init__(self, root: Path) -> None:
        self.roots = tuple(dict.fromkeys((str(root), str(root.resolve()))))

    def __call__(self, change: Any, path: str) -> bool:
        for root in self.roots:
            rel = os.path.relpath(path, root)
            if not rel.startswith(".."):
                return rel != "." and not any(is_ignored_name(part) for part in Path(rel).parts)
        return False


WatchMode = Literal["inotify", "poll"]


async def watch(root: Path, sync: Sync, mode: WatchMode, poll_interval: float, stop: asyncio.Event) -> None:
    """`inotify`: rescan after each batch of relevant changes reported by watchfiles (native
    events; a batch closes after WATCH_STEP_MS without changes, at most WATCH_MAX_MS after its
    first one). `poll` (network filesystems): a full rescan every `poll_interval` seconds. A
    rescan hashes every note, so unlike mtime-based polling it never misses a quick second save
    (D19). If native watching fails (e.g. the inotify watch limit), fall back to polling."""
    if mode == "inotify":
        from watchfiles import awatch  # imported lazily: HOUSEBOOK_WATCH=off/poll never load it

        try:
            async for changes in awatch(
                root,
                watch_filter=WatchFilter(root),
                step=WATCH_STEP_MS,
                debounce=WATCH_MAX_MS,
                stop_event=stop,
                ignore_permission_denied=True,
                recursive=True,
            ):
                log.debug("watch batch", extra={"changes": len(changes)})
                try:
                    await sync.rescan()
                except Exception:
                    log.exception("rescan after file change failed")
            return
        except OSError as e:
            log.warning("native file watching failed; falling back to polling", extra={"error": str(e)})
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), poll_interval)
            return
        except TimeoutError:
            pass
        try:
            await sync.rescan()
        except Exception:
            log.exception("polling rescan failed")
