"""Application factory: config -> adapters -> services -> routes."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from housebook import __version__
from housebook.adapters.fs import FsAttachmentStore, FsHouseRepo, MarkdownNoteRepo
from housebook.api.context import AppContext
from housebook.api.middleware import Compression, HeadAsGet, WriteGuard
from housebook.api.routes import api, calendar_feed, health
from housebook.api.spa import mount_spa
from housebook.config import Settings
from housebook.domain.catalog import load_catalog
from housebook.domain.finishes import load_finishes
from housebook.lock import LockHeld, ProcessLock, network_fs_type
from housebook.services.calendar_links import CalendarLinks
from housebook.services.indexer import Indexer
from housebook.services.sync import Hub, Sync, watch
from housebook.services.writer import WriteError, Writer

log = logging.getLogger(__name__)


async def _rescan_loop(ctx: AppContext, interval: float) -> None:
    """Periodic full rescan: the correctness path (the watcher is only for speed, D10)."""
    while True:
        await asyncio.sleep(interval)
        try:
            await ctx.sync.rescan()
        except Exception:
            log.exception("rescan failed")


async def _validation_error(request: Request, exc: Exception) -> Response:
    """FastAPI's 422, minus large `input` echoes (a 4 MiB body must not come back verbatim)."""
    assert isinstance(exc, RequestValidationError)
    errors = [{k: v for k, v in e.items() if k != "input" or len(repr(v)) <= 200} for e in exc.errors()]
    return JSONResponse({"detail": jsonable_encoder(errors)}, status_code=422)


async def _write_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, WriteError)
    return JSONResponse({"detail": exc.detail, **exc.extra}, status_code=exc.status, headers=exc.headers)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    ctx: AppContext = app.state.ctx
    s = ctx.settings
    ctx.loop = asyncio.get_running_loop()
    locked = False
    try:
        ctx.lock.acquire()
        locked = True
    except LockHeld:
        raise
    except OSError as e:
        # Read-only data root: keep serving reads; /readyz reports not ready.
        log.error("cannot take the process lock", extra={"path": str(ctx.lock.path), "error": str(e)})
    if fs := network_fs_type(s.data_dir):
        log.warning(
            "data folder is on a network filesystem: flock only guards this host, and inotify misses "
            "changes made by other machines; use HOUSEBOOK_WATCH=poll",
            extra={"fstype": fs, "watch": s.watch},
        )
    await ctx.sync.rescan()
    if locked:
        try:
            purged = await asyncio.to_thread(ctx.writer.notes.purge_trash, ctx.clock())
            if purged:
                log.info("trash purged", extra={"entries": purged})
        except OSError as e:
            log.warning("trash purge failed", extra={"error": str(e)})

    stop = asyncio.Event()
    tasks: list[asyncio.Task[None]] = []
    if s.watch != "off":
        tasks.append(asyncio.create_task(watch(s.data_dir, ctx.sync, s.watch, s.poll_interval, stop)))
    if s.rescan_interval > 0:
        tasks.append(asyncio.create_task(_rescan_loop(ctx, s.rescan_interval)))
    try:
        yield
    finally:
        stop.set()
        ctx.hub.close_all()
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        ctx.sync.close()
        ctx.lock.release()


def create_app(settings: Settings, clock: Callable[[], datetime] | None = None) -> FastAPI:
    catalog = load_catalog(settings.catalog_path)
    data = settings.data_dir
    house_repo, notes = FsHouseRepo(data), MarkdownNoteRepo(data, settings.notes_dir)
    indexer = Indexer(house_repo, notes, catalog, load_finishes(settings.finishes_path))
    hub = Hub()
    now = clock or (lambda: datetime.now(UTC))
    ctx = AppContext(
        settings=settings,
        catalog=catalog,
        indexer=indexer,
        attachments=FsAttachmentStore(data),
        lock=ProcessLock(data),
        hub=hub,
        sync=Sync(indexer, hub),
        writer=Writer(house_repo, notes, indexer, catalog, settings, now),
        calendar_links=CalendarLinks(data),
    )
    if clock:
        ctx.clock = clock

    app = FastAPI(
        title="Housebook",
        version=__version__,
        lifespan=_lifespan,
        # Docs are served by routes in api/routes.py, behind the same auth as the rest of /api.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.ctx = ctx
    app.add_exception_handler(WriteError, _write_error)
    app.add_exception_handler(RequestValidationError, _validation_error)

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    app.include_router(health)
    app.include_router(calendar_feed)  # its own code instead of a login (D40)
    app.include_router(api)
    mount_spa(app, settings.static_dir)  # last: catch-all
    # Outermost last: HEAD is turned into GET before gzip decides on headers.
    app.add_middleware(WriteGuard, settings=settings)
    app.add_middleware(Compression)
    app.add_middleware(HeadAsGet)
    return app


def close_streams(app: FastAPI) -> None:
    """Called from the SIGTERM/SIGINT handler (any thread): end the SSE streams on the loop.
    uvicorn waits for open connections before the lifespan shutdown runs, so without this an
    open event stream keeps the process alive until it is killed."""
    ctx: AppContext = app.state.ctx
    if ctx.loop is not None and not ctx.loop.is_closed():
        ctx.loop.call_soon_threadsafe(ctx.hub.close_all)
