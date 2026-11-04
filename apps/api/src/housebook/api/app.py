"""Application factory: config -> adapters -> services -> routes."""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Request, Response

from housebook import __version__
from housebook.adapters.fs import FsAttachmentStore, FsHouseRepo, MarkdownNoteRepo
from housebook.api.context import AppContext
from housebook.api.middleware import Compression, HeadAsGet
from housebook.api.routes import api, health
from housebook.api.spa import mount_spa
from housebook.config import Settings
from housebook.domain.catalog import load_catalog
from housebook.lock import LockHeld, ProcessLock
from housebook.services.indexer import Indexer

log = logging.getLogger(__name__)


async def _rescan_loop(ctx: AppContext, interval: float) -> None:
    """Periodic full rescan: the correctness path (the watcher in milestone 4 is for speed)."""
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(ctx.indexer.scan)
        except Exception:
            log.exception("rescan failed")


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    ctx: AppContext = app.state.ctx
    s = ctx.settings
    try:
        ctx.lock.acquire()
    except LockHeld:
        raise
    except OSError as e:
        # Read-only data root: keep serving reads; /readyz reports not ready.
        log.error("cannot take the process lock", extra={"path": str(ctx.lock.path), "error": str(e)})
    await asyncio.to_thread(ctx.indexer.scan)
    if s.watch != "off":
        log.info("file watcher arrives in milestone 4; relying on periodic rescans", extra={"watch": s.watch})
    task = asyncio.create_task(_rescan_loop(ctx, s.rescan_interval)) if s.rescan_interval > 0 else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        ctx.lock.release()


def create_app(settings: Settings, clock: Callable[[], datetime] | None = None) -> FastAPI:
    catalog = load_catalog(settings.catalog_path)
    data = settings.data_dir
    ctx = AppContext(
        settings=settings,
        catalog=catalog,
        indexer=Indexer(FsHouseRepo(data), MarkdownNoteRepo(data, settings.notes_dir), catalog),
        attachments=FsAttachmentStore(data),
        lock=ProcessLock(data),
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

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    app.include_router(health)
    app.include_router(api)
    mount_spa(app, settings.static_dir)  # last: catch-all
    # Outermost last: HEAD is turned into GET before gzip decides on headers.
    app.add_middleware(Compression)
    app.add_middleware(HeadAsGet)
    return app
