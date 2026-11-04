"""Wiring holder shared by the routes (one per app)."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from fastapi import HTTPException, Request, status

from housebook.adapters.fs import FsAttachmentStore
from housebook.config import Settings
from housebook.domain.catalog import Catalog
from housebook.domain.status import today_in
from housebook.lock import ProcessLock
from housebook.services.indexer import Indexer, IndexState


def _utcnow() -> datetime:
    return datetime.now(UTC)


@dataclass
class AppContext:
    settings: Settings
    catalog: Catalog
    indexer: Indexer
    attachments: FsAttachmentStore
    lock: ProcessLock
    clock: Callable[[], datetime] = _utcnow
    # (scan time, today) -> (body, etag); the snapshot is rebuilt only when either changes
    _snapshot: tuple[tuple[datetime, date], bytes, str] | None = field(default=None, repr=False)

    def today(self) -> date:
        return today_in(self.settings.tz, self.clock())

    def state(self) -> IndexState:
        state = self.indexer.state
        if state is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Index not ready")
        return state

    def cached_snapshot(self, key: tuple[datetime, date], build: Callable[[], Any]) -> tuple[bytes, str]:
        if self._snapshot and self._snapshot[0] == key:
            return self._snapshot[1], self._snapshot[2]
        body = json.dumps(build(), ensure_ascii=False, separators=(",", ":")).encode()
        etag = hashlib.sha256(body).hexdigest()[:32]
        self._snapshot = (key, body, etag)
        return body, etag


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx
