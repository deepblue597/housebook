"""HTTP API: reads (milestone 1), writes and the event stream (milestone 4)."""

import asyncio
import json
import logging
import os
import posixpath
from collections.abc import AsyncIterator
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse

from housebook.adapters.memory_search import MemorySearchIndex
from housebook.api.auth import Identity, identify
from housebook.api.context import AppContext, get_ctx
from housebook.api.http import NO_CACHE, matches_if_none_match, quote_etag
from housebook.api.schemas import (
    AdoptIn,
    ErrorOut,
    HealthOut,
    ItemCreateIn,
    ItemDetailOut,
    ItemListOut,
    ItemPatchIn,
    LogEntryIn,
    MeOut,
    ProblemsOut,
    SnapshotOut,
)
from housebook.api.views import item_out
from housebook.domain.catalog import Catalog
from housebook.domain.filetypes import INLINE_TYPES, SNIFF_BYTES, sniff
from housebook.domain.house import House
from housebook.domain.paths import is_safe_name
from housebook.domain.status import due_sort_key, is_due_within
from housebook.domain.text import nfc
from housebook.ports import UnsafePath
from housebook.services.indexer import MAX_HOUSE_BYTES, IndexState
from housebook.services.sync import items_version, resync_payload, sse_frame
from housebook.services.writer import field_error, unprocessable, validate_house

log = logging.getLogger(__name__)

Ctx = Annotated[AppContext, Depends(get_ctx)]


def current_identity(request: Request, ctx: Ctx) -> Identity:
    identity = identify(request, ctx.settings)
    request.state.identity = identity
    return identity


api = APIRouter(prefix="/api", dependencies=[Depends(current_identity)])
health = APIRouter()

# Only sniffed PDFs and raster images are shown inline; everything else is a download.
# Plain-text extensions are labelled for convenience (always as a download).
DOWNLOAD_TYPES = {".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"}
SANDBOX_CSP = "default-src 'none'; sandbox"


def _not_modified(etag: str) -> Response:
    return Response(
        status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": quote_etag(etag), "Cache-Control": NO_CACHE}
    )


@api.get("/openapi.json", include_in_schema=False)
def openapi_spec(request: Request) -> JSONResponse:
    return JSONResponse(request.app.openapi())


@api.get("/docs", include_in_schema=False)
def swagger_ui() -> HTMLResponse:
    return get_swagger_ui_html(openapi_url="/api/openapi.json", title="Housebook API")


@api.get("/house", response_model=House, responses={304: {}, 404: {}})
def get_house(request: Request, ctx: Ctx) -> Response:
    hs = ctx.state().house
    if hs.house is None or hs.etag is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "house.json is missing or invalid; see /api/problems")
    if matches_if_none_match(request, hs.etag):
        return _not_modified(hs.etag)
    headers = {"ETag": quote_etag(hs.etag), "Cache-Control": NO_CACHE}
    if hs.read_only:
        headers["X-Housebook-Read-Only"] = "true"
    return JSONResponse(hs.house.dump(), headers=headers)


@api.get("/snapshot", response_model=SnapshotOut, responses={304: {}})
def get_snapshot(request: Request, ctx: Ctx) -> Response:
    """House + every item (with body and status) in one response, for first load, the
    offline cache and client-side search. Poll with If-None-Match."""
    state = ctx.state()
    today = ctx.today()

    def build() -> dict:
        hs = state.house
        snap = SnapshotOut(
            today=today,
            timezone=ctx.settings.tz,
            house=None,
            house_etag=hs.etag,
            house_read_only=hs.read_only,
            house_schema_version=hs.schema_version,
            items_version=items_version(state),
            items=[item_out(i, today, ctx.settings, body=True) for i in state.items.values()],
            problem_count=len(state.problems),
        ).model_dump(mode="json")
        snap["house"] = hs.house.dump() if hs.house else None
        return snap

    body, etag = ctx.cached_snapshot((state.scanned_at, today), build)
    if matches_if_none_match(request, etag):
        return _not_modified(etag)
    return Response(body, media_type="application/json", headers={"ETag": quote_etag(etag), "Cache-Control": NO_CACHE})


@api.get("/items", response_model=ItemListOut)
def list_items(
    ctx: Ctx,
    q: Annotated[str | None, Query(max_length=200, description="Search query (DESIGN 15.9)")] = None,
    due: Annotated[int | None, Query(ge=0, le=3650, description="Check or warranty due within N days")] = None,
) -> ItemListOut:
    state = ctx.state()
    today = ctx.today()
    items = list(state.items.values())
    if q is not None:
        # Contract §5: an empty or blank query matches nothing (no q at all lists everything).
        items = [state.items[i] for i in MemorySearchIndex(state.search_docs).search(q)]
    else:
        items.sort(key=lambda i: (i.fields.name or i.rel).casefold())
    out = [item_out(i, today, ctx.settings) for i in items]
    if due is not None:
        out = [o for o in out if is_due_within(o.status, due)]
        if q is None:
            out.sort(key=lambda o: due_sort_key(o.status, due))
    return ItemListOut(items=out, count=len(out))


@api.get("/items/{item_id}", response_model=ItemDetailOut)
def get_item(item_id: str, ctx: Ctx) -> Response:
    item = ctx.state().items.get(item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No item with this id")
    out = item_out(item, ctx.today(), ctx.settings, body=True)
    # ETag = note content hash (for If-Match on writes). The body also has derived parts
    # (status, location), so no 304 here; /api/snapshot is the conditional-GET path.
    return JSONResponse(out.model_dump(mode="json"), headers={"ETag": quote_etag(item.hash), "Cache-Control": NO_CACHE})


@api.get("/items/{item_id}/attachments/{name}", response_class=FileResponse)
def get_attachment(item_id: str, name: str, ctx: Ctx) -> FileResponse:
    if not is_safe_name(name):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid file name")
    item = ctx.state().items.get(item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No item with this id")
    att = next((a for a in item.attachments if a.name == nfc(name)), None)
    if att is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment")
    try:
        path = ctx.attachments.open_path(att.rel)
    except UnsafePath:
        log.warning("attachment rejected", extra={"item_id": item_id, "path": att.rel})
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment") from None

    try:
        with path.open("rb") as f:
            sniffed = sniff(f.read(SNIFF_BYTES))
    except OSError as e:  # e.g. permissions changed since the last scan; never leak the path
        log.warning("attachment unreadable", extra={"item_id": item_id, "path": att.rel, "error": e.strerror})
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such attachment") from None
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache"}
    if sniffed in INLINE_TYPES:
        media_type, disposition = sniffed, "inline"
    else:
        ext = posixpath.splitext(att.name)[1].lower()
        media_type, disposition = sniffed or DOWNLOAD_TYPES.get(ext, "application/octet-stream"), "attachment"
    # Every attachment, PDFs included, is sandboxed: the web app renders PDFs itself with PDF.js
    # (it fetches the bytes; CSP of a fetched resource doesn't apply to the page that fetches
    # it), so nothing relies on the browser's built-in viewer, which refuses sandboxed documents.
    headers["Content-Security-Policy"] = SANDBOX_CSP
    return FileResponse(
        path,
        media_type=media_type,
        filename=att.name,
        content_disposition_type=disposition,
        headers=headers,
        stat_result=os.stat(path),
    )


@api.get("/problems", response_model=ProblemsOut)
def get_problems(ctx: Ctx) -> ProblemsOut:
    state = ctx.state()
    return ProblemsOut(problems=list(state.problems), count=len(state.problems), scanned_at=state.scanned_at)


@api.get("/catalog", response_model=Catalog)
def get_catalog(ctx: Ctx) -> Response:
    return JSONResponse(ctx.catalog.model_dump(mode="json", by_alias=True), headers={"Cache-Control": NO_CACHE})


@api.get("/me", response_model=MeOut)
def get_me(request: Request, ctx: Ctx) -> MeOut:
    identity: Identity = request.state.identity
    return MeOut(user=identity.user, role=identity.role, auth_mode=ctx.settings.auth_mode)


@health.get("/healthz", response_model=HealthOut)
def healthz() -> HealthOut:
    return HealthOut(status="ok")


@health.get("/readyz", response_model=HealthOut, responses={503: {"model": HealthOut}})
def readyz(ctx: Ctx) -> Response:
    """Ready = first scan done and the data root writable (needed from milestone 4 on)."""
    checks = {
        "scanned": ctx.indexer.state is not None,
        "dataWritable": os.access(ctx.settings.data_dir, os.W_OK),
    }
    ok = all(checks.values())
    return JSONResponse(
        HealthOut(status="ready" if ok else "not ready", checks=checks).model_dump(),
        status_code=200 if ok else 503,
    )


# --- writes (milestone 4) ---------------------------------------------------------------------
#
# Editors only. JSON bodies must say so (`Content-Type: application/json`, or
# `application/merge-patch+json` for PATCH): a cross-site form or no-cors fetch can't send that
# without a CORS preflight, which is the CSRF guard from DESIGN 15.13.


def require_editor(identity: Annotated[Identity, Depends(current_identity)]) -> None:
    if identity.role != "editor":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Editor role required")


JSON_TYPES = {"application/json", "application/merge-patch+json"}


def require_json(request: Request) -> None:
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype not in JSON_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")


EDIT = [Depends(require_editor), Depends(require_json)]
IfMatch = Annotated[str | None, Header(description="ETag from the last read (`*` overwrites whatever is there)")]
IfNoneMatch = Annotated[str | None, Header(description="`*` to create house.json when it doesn't exist yet")]


def _errors(*codes: int) -> dict[int | str, dict[str, Any]]:
    return {c: {"model": ErrorOut} for c in codes}


def _item_response(ctx: AppContext, state: IndexState, item_id: str, status_code: int = 200) -> JSONResponse:
    item = state.items.get(item_id)
    if item is None:  # vanished between the write and the rescan (e.g. deleted in Obsidian)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No item with this id")
    out = item_out(item, ctx.today(), ctx.settings, body=True)
    headers = {"ETag": quote_etag(item.hash), "Cache-Control": NO_CACHE}
    if status_code == 201:
        headers["Location"] = f"/api/items/{quote(item_id, safe='')}"
    return JSONResponse(out.model_dump(mode="json"), status_code=status_code, headers=headers)


@api.put(
    "/house",
    response_model=House,
    dependencies=EDIT,
    responses=_errors(409, 412, 413, 415, 422, 428),
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/House"}}},
        }
    },
)
async def put_house(
    request: Request, ctx: Ctx, if_match: IfMatch = None, if_none_match: IfNoneMatch = None
) -> Response:
    """Replace the layout (the only writer of house.json, D8). Validated fully (422 lists every
    issue with its location); `If-Match` against the file on disk (428 without it, 412 on a
    mismatch); the previous file is kept in `.housebook/history/` (last 50); written atomically
    and deterministically. 409 when house.json is read-only (newer schemaVersion, invalid)."""
    raw = await request.body()
    if len(raw) > MAX_HOUSE_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "house.json is limited to 16 MiB")
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        raise unprocessable([field_error([], "body is not valid JSON", "json_invalid")]) from None
    house = validate_house(data)
    (etag, written), _ = await ctx.sync.write(lambda: ctx.writer.put_house(house, if_match, if_none_match))
    return JSONResponse(written.dump(), headers={"ETag": quote_etag(etag), "Cache-Control": NO_CACHE})


@api.post(
    "/items",
    response_model=ItemDetailOut,
    status_code=201,
    dependencies=EDIT,
    responses=_errors(409, 413, 415, 422),
)
async def create_item(body: ItemCreateIn, ctx: Ctx) -> Response:
    """Create a note from the type's template at `<notes>/<Room>/<Name>.md`. The layout is not
    touched: add the placement with PUT /api/house afterwards (D8)."""
    item_id, state = await ctx.sync.write(
        lambda: ctx.writer.create_item(body.type, body.name, body.room_id, body.frontmatter, body.body)
    )
    return _item_response(ctx, state, item_id, 201)


@api.post("/items/adopt", response_model=ItemDetailOut, dependencies=EDIT, responses=_errors(404, 409, 415, 422))
async def adopt_item(body: AdoptIn, ctx: Ctx) -> Response:
    """Give a tagged note without `housebook_id` (a `not_adopted` problem) a new id."""
    item_id, state = await ctx.sync.write(lambda: ctx.writer.adopt(body.path))
    return _item_response(ctx, state, item_id)


@api.patch(
    "/items/{item_id}",
    response_model=ItemDetailOut,
    dependencies=EDIT,
    responses=_errors(404, 409, 412, 413, 415, 422, 428),
)
async def patch_item(item_id: str, body: ItemPatchIn, ctx: Ctx, if_match: IfMatch = None) -> Response:
    """Merge-patch the frontmatter (minimal diff: only changed keys' lines are rewritten;
    comments, order and unknown keys stay) and/or replace the body."""
    _, state = await ctx.sync.write(lambda: ctx.writer.patch_item(item_id, if_match, body.frontmatter, body.body))
    return _item_response(ctx, state, item_id)


@api.post(
    "/items/{item_id}/log",
    response_model=ItemDetailOut,
    dependencies=EDIT,
    responses=_errors(404, 409, 413, 415, 422),
)
async def append_log(item_id: str, body: LogEntryIn, ctx: Ctx) -> Response:
    """Append `- YYYY-MM-DD text` under `## Maintenance log` (created if missing). No If-Match:
    appends merge with whatever is on disk."""
    text = " ".join(body.text.split())
    if not text:
        raise unprocessable([field_error(["text"], "text must not be blank")])
    day = body.day or ctx.today()
    _, state = await ctx.sync.write(lambda: ctx.writer.append_log(item_id, day, text))
    return _item_response(ctx, state, item_id)


@api.delete(
    "/items/{item_id}",
    status_code=204,
    dependencies=[Depends(require_editor)],
    responses=_errors(404, 412, 428),
)
async def delete_item(item_id: str, ctx: Ctx, if_match: IfMatch = None) -> Response:
    """Move the note (and its attachment folder) to `.housebook/trash/`. Remove the placement
    with PUT /api/house first (D8); otherwise it shows as a missing note."""
    await ctx.sync.write(lambda: ctx.writer.delete_item(item_id, if_match), deleted=[item_id])
    return Response(status_code=204)


# --- events (DESIGN 15.7) -----------------------------------------------------------------------


@api.get(
    "/events",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}, "description": "Server-sent events"}},
)
async def events(request: Request, ctx: Ctx) -> Response:
    """Server-sent events. Starts with `resync`; then `house.changed`, `item.changed`,
    `item.deleted`, `problems.changed`; a `ping` event after 20 s of silence keeps proxies from
    timing out and lets the client detect a dead stream.
    No replay: refetch whatever `resync` says differs."""
    heartbeat = ctx.settings.sse_heartbeat
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    if request.scope.get("housebook.head"):  # HEAD: headers only, never an endless body
        return Response(media_type="text/event-stream", headers=headers)

    async def stream() -> AsyncIterator[str]:
        hub = ctx.hub
        if hub.closed:  # shutting down: don't start a stream the server would wait for
            return
        sub = hub.subscribe()  # before resync, so nothing between the two is missed
        try:
            yield "retry: 5000\n\n"
            state = ctx.indexer.state
            if state is not None:
                yield sse_frame("resync", resync_payload(state))
            while not sub.dropped and not hub.closed:
                try:
                    frame = await asyncio.wait_for(sub.queue.get(), timeout=heartbeat)
                except TimeoutError:
                    # A real event, not a `: comment`: EventSource hides comments, and the
                    # client needs something to run a watchdog on.
                    yield sse_frame("ping", {})
                    continue
                if frame is None:
                    break
                yield frame
        finally:
            hub.unsubscribe(sub)

    return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)
