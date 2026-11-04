"""Serve the built SPA (apps/web/dist) with the caching rules from DESIGN 15.8.

Any GET outside /api returns index.html (client-side routes such as /i/<id>).
Hashed assets are immutable; index.html, sw.js and everything else revalidate.
"""

import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response

from housebook.adapters.fs import resolve_inside
from housebook.api.http import IMMUTABLE, NO_CACHE
from housebook.ports import UnsafePath

# Vite emits assets/<name>-<hash>.<ext>; the hash is 8+ url-safe chars.
_HASHED_RE = re.compile(r"(^|/)assets/.+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$")


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
                    return FileResponse(file, headers={"Cache-Control": cache_control_for(path)})
            except UnsafePath:
                pass
            if _HASHED_RE.search(path):  # a missing hashed asset must not turn into HTML
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
        return FileResponse(index, headers={"Cache-Control": NO_CACHE})
