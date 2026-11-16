"""Receipts in Paperless-ngx (D52, data contract §8.4).

People see a linked receipt through Housebook, never Paperless itself: the backend fetches a
document's title, thumbnail and preview with its own token, and only for documents a note links
(`/api/items/{id}/receipts/...`). Searching Paperless to link a new receipt, with thumbnails, is
for editors only: they could link any document anyway.
"""

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import Field

from housebook.api.context import AppContext
from housebook.api.routes import Ctx, _errors, current_identity, require_editor
from housebook.api.schemas import ApiModel
from housebook.domain.filetypes import INLINE_TYPES, SNIFF_BYTES, sniff
from housebook.domain.receipts import document_id
from housebook.services.indexer import IndexState
from housebook.services.paperless import Document, Paperless, PaperlessError

log = logging.getLogger(__name__)

receipts = APIRouter(prefix="/api", dependencies=[Depends(current_identity)])

FILE_CACHE = "private, max-age=300"
SANDBOX_CSP = "default-src 'none'; sandbox"


class PaperlessDocOut(ApiModel):
    document_id: int
    title: str
    created: str | None = Field(description="YYYY-MM-DD")
    url: str = Field(description="The document's page in Paperless: what a note stores in `receipts`")
    thumb_url: str


class PaperlessSearchOut(ApiModel):
    results: list[PaperlessDocOut]


class ReceiptOut(ApiModel):
    url: str = Field(description="The link as written in the note")
    document_id: int | None = Field(description="Null: not a document on the configured Paperless")
    state: Literal["found", "missing", "unreachable", "link"] = Field(
        description="`found`: Paperless has it; `missing`: Paperless says it doesn't exist; `unreachable`: "
        "Paperless couldn't be asked; `link`: a plain link (no Paperless, or another address)"
    )
    title: str | None = None
    created: str | None = Field(None, description="YYYY-MM-DD")
    thumb_url: str | None = None
    preview_url: str | None = None


class ReceiptsOut(ApiModel):
    receipts: list[ReceiptOut]


def _paperless(ctx: AppContext) -> Paperless:
    if ctx.paperless is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paperless isn't set up (HOUSEBOOK_PAPERLESS_URL)")
    return ctx.paperless


def _unreachable(e: PaperlessError) -> HTTPException:
    log.warning("paperless call failed", extra={"error": str(e)})
    return HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))


def linked_documents(state: IndexState, paperless: Paperless) -> set[int]:
    """Every Paperless document some note links."""
    ids = (document_id(link, paperless.bases) for item in state.items.values() for link in item.fields.receipts)
    return {i for i in ids if i is not None}


async def _noted(ctx: AppContext, paperless: Paperless, doc_id: int, doc: Document | None) -> None:
    """Tell the scan when a linked document went missing or came back (`paperless_missing`)."""
    if paperless.note(doc_id, doc):
        await ctx.sync.rescan()


@receipts.get(
    "/paperless/search",
    response_model=PaperlessSearchOut,
    dependencies=[Depends(require_editor)],
    responses=_errors(403, 404, 502),
)
async def search_paperless(ctx: Ctx, q: str = Query("", max_length=200)) -> PaperlessSearchOut:
    """Search Paperless to link a receipt (editors). Full-text; the newest documents when `q` is empty."""
    paperless = _paperless(ctx)
    try:
        docs = await asyncio.to_thread(paperless.search, q)
    except PaperlessError as e:
        raise _unreachable(e) from None
    return PaperlessSearchOut(
        results=[
            PaperlessDocOut(
                document_id=d.id,
                title=d.title,
                created=d.created,
                url=d.url,
                thumb_url=f"/api/paperless/documents/{d.id}/thumb",
            )
            for d in docs
        ]
    )


@receipts.get(
    "/paperless/documents/{doc_id}/thumb",
    response_class=Response,
    dependencies=[Depends(require_editor)],
    responses={200: {"content": {"image/webp": {}}}, **_errors(403, 404, 502)},
)
async def search_thumb(doc_id: int, ctx: Ctx) -> Response:
    """A search result's thumbnail (editors)."""
    return await _file(ctx, _paperless(ctx), doc_id, "thumb", linked=False)


@receipts.get("/items/{item_id}/receipts", response_model=ReceiptsOut, responses=_errors(404))
async def get_receipts(item_id: str, ctx: Ctx) -> ReceiptsOut:
    """An item's receipts with their title and date from Paperless. When Paperless can't be
    reached the links come back as they are (`unreachable`), so they still open."""
    item = ctx.state().items.get(item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No item with this id")
    paperless = ctx.paperless
    out: list[ReceiptOut] = []
    down = False
    for link in item.fields.receipts:
        doc_id = document_id(link, paperless.bases) if paperless else None
        if paperless is None or doc_id is None:
            out.append(ReceiptOut(url=link, document_id=None, state="link"))
            continue
        if down:
            out.append(ReceiptOut(url=link, document_id=doc_id, state="unreachable"))
            continue
        try:
            doc = await asyncio.to_thread(paperless.document, doc_id)
        except PaperlessError as e:
            log.warning("paperless call failed", extra={"error": str(e), "item_id": item_id})
            down = True
            out.append(ReceiptOut(url=link, document_id=doc_id, state="unreachable"))
            continue
        await _noted(ctx, paperless, doc_id, doc)
        if doc is None:
            out.append(ReceiptOut(url=link, document_id=doc_id, state="missing"))
            continue
        base = f"/api/items/{item_id}/receipts/{doc_id}"
        out.append(
            ReceiptOut(
                url=link,
                document_id=doc_id,
                state="found",
                title=doc.title,
                created=doc.created,
                thumb_url=f"{base}/thumb",
                preview_url=f"{base}/preview",
            )
        )
    return ReceiptsOut(receipts=out)


def _linked(ctx: AppContext, paperless: Paperless, item_id: str, doc_id: int) -> None:
    item = ctx.state().items.get(item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No item with this id")
    if doc_id not in {document_id(link, paperless.bases) for link in item.fields.receipts}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This item doesn't link that document")


@receipts.get(
    "/items/{item_id}/receipts/{doc_id}/{kind}",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}, "image/webp": {}}}, **_errors(404, 502)},
)
async def get_receipt_file(item_id: str, doc_id: int, kind: Literal["thumb", "preview"], ctx: Ctx) -> Response:
    """A linked receipt's thumbnail or the document to view (the PDF Paperless archived, or the
    original image), only for documents this item links."""
    paperless = _paperless(ctx)
    _linked(ctx, paperless, item_id, doc_id)
    return await _file(ctx, paperless, doc_id, kind, linked=True)


async def _file(ctx: AppContext, paperless: Paperless, doc_id: int, kind: str, *, linked: bool) -> Response:
    try:
        file = await asyncio.to_thread(paperless.file, doc_id, kind)
    except PaperlessError as e:
        raise _unreachable(e) from None
    if file is None:
        if linked:
            await _noted(ctx, paperless, doc_id, None)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paperless has no such document")
    # Shown inline only when the bytes are a PDF or an image we know; anything else downloads.
    sniffed = sniff(file.body[:SNIFF_BYTES])
    inline = sniffed in INLINE_TYPES
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": SANDBOX_CSP,
        "Cache-Control": FILE_CACHE,
        "Content-Disposition": "inline" if inline else f'attachment; filename="document-{doc_id}"',
    }
    return Response(file.body, media_type=sniffed if inline else "application/octet-stream", headers=headers)
