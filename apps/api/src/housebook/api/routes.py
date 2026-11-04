"""Read-only API (milestone 1). Write endpoints (milestone 4) go next to these."""

import logging
import os
import posixpath
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from housebook.adapters.memory_search import MemorySearchIndex
from housebook.api.auth import Identity, identify
from housebook.api.context import AppContext, get_ctx
from housebook.api.http import NO_CACHE, matches_if_none_match, quote_etag
from housebook.api.schemas import (
    HealthOut,
    ItemDetailOut,
    ItemListOut,
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
    if media_type != "application/pdf":
        headers["Content-Security-Policy"] = SANDBOX_CSP
    # PDFs get no `sandbox`: Chrome's built-in viewer refuses to render a sandboxed document
    # (Firefox's pdf.js copes). They rely on the sniffed type + nosniff instead. Once the web
    # app renders PDFs itself with PDF.js (fetching bytes, not navigating), PDFs can be served
    # sandboxed like everything else.
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
