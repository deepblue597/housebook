"""Small ASGI middlewares."""

import re

from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class HeadAsGet:
    """Answer HEAD for every GET route: route it as GET and drop the body.

    FastAPI's `@get` routes don't accept HEAD, so without this a HEAD fell through to the
    SPA catch-all and returned 404. Headers (Content-Length, ETag, ...) stay as for GET."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "HEAD":
            await self.app(scope, receive, send)
            return

        async def send_headers_only(message: Message) -> None:
            if message["type"] == "http.response.body":
                if message.get("more_body", False):
                    return
                message = {"type": "http.response.body", "body": b"", "more_body": False}
            await send(message)

        await self.app({**scope, "method": "GET"}, receive, send_headers_only)


# Compress JSON (and the SPA's text assets), never files that are already compressed or are
# served as downloads, and never event streams (SSE arrives in milestone 4). Starlette also
# leaves 206 partial responses alone.
GZIP_EXCLUDED = (
    *DEFAULT_EXCLUDED_CONTENT_TYPES,
    "text/event-stream",
    "application/pdf",
    "application/octet-stream",
    "image/*",
)


# Responses whose strong ETag is the *file's* content hash (the If-Match token for writes in
# milestone 4, and If-Range for attachments) are never compressed, so that ETag stays strong
# and identical for every client. They are small (layout, one note) or binary (attachments).
_UNCOMPRESSED_PATHS = re.compile(r"^/api/(house|items/[^/]+(/attachments/.*)?)$")


def accepts_gzip(header: str) -> bool:
    """RFC 9110 content negotiation: gzip is acceptable unless its q (or `*`'s) is 0."""
    gzip_q: float | None = None
    star_q: float | None = None
    for part in header.split(","):
        name, *params = (p.strip() for p in part.split(";"))
        q = 1.0
        for param in params:
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        if name.lower() == "gzip":
            gzip_q = q
        elif name == "*":
            star_q = q
    if gzip_q is not None:
        return gzip_q > 0
    return star_q is not None and star_q > 0


class Compression:
    """Starlette's GZipMiddleware plus the HTTP details it leaves out:

    - `Accept-Encoding: gzip;q=0` means "no gzip" (Starlette only looks for the substring);
    - responses that may be compressed get `Vary: Accept-Encoding`, 304s included;
    - their ETag is weak whenever the client accepts gzip, compressed or not (small bodies
      stay plain), so a 200 and a later 304 always carry the same ETag and gzip and identity
      bodies never share a strong one. If-None-Match uses weak comparison, so polling works."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=6, exclude_content_types=GZIP_EXCLUDED)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _UNCOMPRESSED_PATHS.match(scope["path"]):
            await self.app(scope, receive, send)
            return
        gzip_ok = accepts_gzip(Headers(scope=scope).get("accept-encoding", ""))
        if not gzip_ok:  # hide the header so Starlette's substring check can't misread it
            scope = {**scope, "headers": [(k, v) for k, v in scope["headers"] if k != b"accept-encoding"]}

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.add_vary_header("Accept-Encoding")
                etag = headers.get("etag")
                if gzip_ok and etag and not etag.startswith("W/"):
                    headers["etag"] = "W/" + etag
            await send(message)

        await self.gzip(scope, receive, send_with_headers)
