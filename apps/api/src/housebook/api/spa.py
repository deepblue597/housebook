"""Serve the built SPA (apps/web/dist) with the caching rules from DESIGN 15.8.

Any GET outside /api returns index.html (client-side routes such as /i/<id>).
Hashed assets are immutable; index.html, sw.js and everything else revalidate.
"""

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response

from housebook.adapters.fs import resolve_inside
from housebook.api.http import IMMUTABLE, NO_CACHE, matches_if_none_match
from housebook.ports import UnsafePath

# Vite emits assets/<name>-<hash>.<ext>; the hash is 8+ url-safe chars.
_HASHED_RE = re.compile(r"(^|/)assets/.+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$")

# Types Python's built-in mimetypes table lacks; the slim image has no /etc/mime.types,
# so these would otherwise be served as application/octet-stream (under nosniff).
_MEDIA_TYPES = {".glb": "model/gltf-binary", ".gltf": "model/gltf+json"}


def cache_control_for(rel: str) -> str:
    return IMMUTABLE if _HASHED_RE.search(rel) else NO_CACHE


def mount_spa(app: FastAPI, static_dir: Path | None) -> None:
    index = static_dir / "index.html" if static_dir else None
    has_spa = index is not None and index.is_file()

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str, request: Request) -> Response:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        if not has_spa:
            if path == "":
                return JSONResponse({"name": "housebook", "web": "not built", "api": "/api/docs"})
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        assert static_dir is not None and index is not None
        if path:
            try:
                file = resolve_inside(static_dir, path)
                if file.is_file():
                    return _file_response(file, cache_control_for(path), request)
            except UnsafePath:
                pass
            if _HASHED_RE.search(path):  # a missing hashed asset must not turn into HTML
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        return _file_response(index, NO_CACHE, request)


def _file_response(path: Path, cache_control: str, request: Request) -> Response:
    """FileResponse plus conditional GET: Starlette sets an ETag but never answers
    If-None-Match, so index.html (no-cache) was re-downloaded on every revalidation."""
    response = FileResponse(
        path,
        headers={"Cache-Control": cache_control},
        media_type=_MEDIA_TYPES.get(path.suffix.lower()),
        stat_result=path.stat(),
    )
    etag = response.headers["etag"]
    if matches_if_none_match(request, etag.removeprefix("W/").strip('"')):
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag, "Cache-Control": cache_control}
        )
    return response
