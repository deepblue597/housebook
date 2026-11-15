"""Small ASGI middlewares."""

import json
import re

from fastapi import HTTPException
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from housebook.api.auth import identify
from housebook.config import Settings
from housebook.services.sessions import Sessions


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

        # `housebook.head` lets endless responses (the event stream) skip their body.
        await self.app({**scope, "method": "GET", "housebook.head": True}, receive, send_headers_only)


# Compress JSON (and the SPA's text assets), never files that are already compressed or are
# served as downloads, and never event streams (/api/events). Starlette also
# leaves 206 partial responses alone.
GZIP_EXCLUDED = (
    *DEFAULT_EXCLUDED_CONTENT_TYPES,
    "text/event-stream",
    "application/pdf",
    "application/octet-stream",
    "application/zip",
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
        if (
            scope["type"] != "http"
            or scope["method"] not in ("GET", "HEAD")  # write responses: small, and their ETag stays strong
            or _UNCOMPRESSED_PATHS.match(scope["path"])
        ):
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


# Request bodies are bounded before anything is parsed: a note is at most 4 MiB of UTF-8, which
# JSON escaping (\uXXXX) can grow up to 6x; house.json is at most 16 MiB.
HOUSE_BODY_LIMIT = 17 * 1024 * 1024
WRITE_BODY_LIMIT = 25 * 1024 * 1024
_SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
# Writes any signed-in role may make: a person's own calendar link (D40). Still authenticated,
# and their routes still require a JSON body.
VIEWER_WRITES = frozenset({"/api/calendar/link"})


async def _send_json(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(body)).encode()),
        (b"x-content-type-options", b"nosniff"),
        (b"cache-control", b"no-store"),
    ]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class WriteGuard:
    """For every write under /api: authenticate and require the editor role (except the few
    VIEWER_WRITES, which only need a login), then bound the body
    (Content-Length up front, the streamed byte count for chunked bodies), all before the route
    reads or parses anything. A viewer's 150 MB upload is refused without being buffered."""

    def __init__(self, app: ASGIApp, settings: Settings, sessions: Sessions | None = None) -> None:
        self.app = app
        self.settings = settings
        self.sessions = sessions

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in _SAFE_METHODS or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, send)
            return
        try:
            identity = identify(Request(scope), self.settings, self.sessions)
        except HTTPException as e:
            await _send_json(send, e.status_code, str(e.detail))
            return
        if identity.role != "editor" and scope["path"] not in VIEWER_WRITES:
            await _send_json(send, 403, "Editor role required")
            return
        limit = HOUSE_BODY_LIMIT if scope["path"] == "/api/house" else WRITE_BODY_LIMIT
        too_large = f"request body is larger than {limit // (1024 * 1024)} MiB"
        length = Headers(scope=scope).get("content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            await _send_json(send, 413 if length.isdigit() else 400, too_large if length.isdigit() else "bad length")
            return

        received = 0
        over = False
        answered = False

        async def limited_receive() -> Message:
            nonlocal received, over
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    over = True
                    return {"type": "http.disconnect"}  # the route stops reading
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal answered
            if over:  # whatever the route made of the cut-off body, the answer is 413
                if not answered and message["type"] == "http.response.start":
                    answered = True
                    await _send_json(send, 413, too_large)
                return
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not over:
                raise
        if over and not answered:
            await _send_json(send, 413, too_large)
