"""Calendar links (D40): one private link per person, for the calendar feed.

Calendar apps can't log in, so the link carries a random code. Only its SHA-256 is stored, in
`.housebook/calendar-links.json` (the data root may be synced or backed up): the full link is
shown once, when it is made. Making a new link replaces the old one, which stops working.

A person is the proxy's user name in `proxy` mode; in `none` mode there is no login, so the
household shares one link (key "").
"""

import hashlib
import hmac
import json
import logging
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from housebook.adapters.fs import STATE_DIR, atomic_write

log = logging.getLogger(__name__)

FILE = "calendar-links.json"
VERSION = 1


@dataclass(frozen=True)
class CalendarLink:
    user: str  # "" in `none` mode
    created_at: datetime
    origin: str  # where the app was opened when the link was made; item links point there


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def clean_origin(origin: str | None) -> str | None:
    """`https://host[:port]` from an Origin header or base URL; None if it isn't one."""
    if not origin:
        return None
    try:
        parts = urlsplit(origin.strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        return None
    return f"{parts.scheme}://{parts.netloc}"


class CalendarLinks:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / STATE_DIR / FILE
        self._lock = threading.Lock()

    def _read(self) -> dict[str, dict[str, str]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as e:
            # A broken file means no link works until a new one is made; nothing else breaks.
            log.warning("calendar links unreadable", extra={"path": str(self.path), "error": str(e)})
            return {}
        links = raw.get("links") if isinstance(raw, dict) else None
        if not isinstance(links, dict):
            return {}
        return {
            u: v
            for u, v in links.items()
            if isinstance(u, str)
            and isinstance(v, dict)
            and all(isinstance(v.get(k), str) for k in ("hash", "createdAt", "origin"))
        }

    def _write(self, links: dict[str, dict[str, str]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        body = json.dumps({"version": VERSION, "links": links}, indent=2, sort_keys=True) + "\n"
        atomic_write(self.path, body.encode())

    @staticmethod
    def _link(user: str, v: dict[str, str]) -> CalendarLink | None:
        try:
            created = datetime.fromisoformat(v["createdAt"])
        except ValueError:
            return None
        return CalendarLink(user=user, created_at=created, origin=v["origin"])

    def get(self, user: str) -> CalendarLink | None:
        v = self._read().get(user)
        return self._link(user, v) if v else None

    def create(self, user: str, origin: str, now: datetime) -> tuple[str, CalendarLink]:
        """A new code for `user`, replacing theirs. Returns the code (shown once) and the link."""
        token = secrets.token_urlsafe(32)
        with self._lock:
            links = self._read()
            links[user] = {"hash": _hash(token), "createdAt": now.isoformat(), "origin": origin}
            self._write(links)
        return token, CalendarLink(user=user, created_at=now, origin=origin)

    def delete(self, user: str) -> bool:
        with self._lock:
            links = self._read()
            if user not in links:
                return False
            del links[user]
            self._write(links)
            return True

    def find(self, token: str) -> CalendarLink | None:
        """The link a code belongs to (constant-time compare per stored hash)."""
        if not token or len(token) > 200:
            return None
        h = _hash(token)
        for user, v in self._read().items():
            if hmac.compare_digest(v["hash"], h):
                return self._link(user, v)
        return None
