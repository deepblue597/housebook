"""ETag and caching helpers."""

from fastapi import Request

NO_CACHE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"


def quote_etag(value: str) -> str:
    return f'"{value}"'


def matches_if_none_match(request: Request, etag: str) -> bool:
    """True if the client already holds `etag` (weak comparison, as RFC 9110 requires here)."""
    header = request.headers.get("if-none-match")
    if not header:
        return False
    if header.strip() == "*":
        return True
    wanted = quote_etag(etag)
    return any(tag.strip().removeprefix("W/") == wanted for tag in header.split(","))
