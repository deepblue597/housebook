"""Signed cookies for the built-in login (D48).

A cookie is `<payload>.<signature>`: the payload is base64url JSON with an expiry, the
signature an HMAC-SHA256 over a purpose label and the payload, so a login cookie can never be
replayed as a session. Nothing is stored on the server: logging out deletes the cookie, and a
session ends by itself after HOUSEBOOK_SESSION_DAYS.

The key is HOUSEBOOK_SESSION_SECRET, or 32 random bytes kept in `.housebook/session-key` so a
restart doesn't sign everyone out. Deleting that file signs everyone out.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

KEY_FILE = Path(".housebook") / "session-key"


@dataclass(frozen=True)
class Session:
    user: str
    name: str | None
    groups: tuple[str, ...]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Signer:
    def __init__(self, key: bytes, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._key = key
        self._clock = clock

    def _now(self) -> int:
        return int(self._clock().timestamp())

    def _mac(self, purpose: str, payload: str) -> str:
        return _b64(hmac.new(self._key, f"{purpose}\0{payload}".encode(), hashlib.sha256).digest())

    def sign(self, purpose: str, data: dict[str, Any], ttl: float) -> str:
        payload = _b64(json.dumps({**data, "exp": self._now() + int(ttl)}, separators=(",", ":")).encode())
        return f"{payload}.{self._mac(purpose, payload)}"

    def unsign(self, purpose: str, token: str | None) -> dict[str, Any] | None:
        """The data, or None when the token is missing, altered, for another purpose or expired."""
        if not token or token.count(".") != 1:
            return None
        payload, mac = token.split(".")
        if not hmac.compare_digest(mac, self._mac(purpose, payload)):
            return None
        try:
            data = json.loads(_unb64(payload))
        except ValueError:
            return None
        if not isinstance(data, dict) or not isinstance(data.get("exp"), int) or data["exp"] <= self._now():
            return None
        return data


class Sessions:
    """Session cookies: who is signed in, and their groups at the time they signed in."""

    def __init__(self, signer: Signer, days: float) -> None:
        self.signer = signer
        self.max_age = int(days * 86400)

    def issue(self, s: Session) -> str:
        return self.signer.sign("session", {"u": s.user, "n": s.name, "g": list(s.groups)}, self.max_age)

    def read(self, token: str | None) -> Session | None:
        data = self.signer.unsign("session", token)
        if data is None:
            return None
        user, name, groups = data.get("u"), data.get("n"), data.get("g")
        if not isinstance(user, str) or not user or not isinstance(groups, list):
            return None
        return Session(
            user=user,
            name=name if isinstance(name, str) else None,
            groups=tuple(g for g in groups if isinstance(g, str)),
        )


def session_key(secret: str | None, data_dir: Path) -> bytes:
    """HOUSEBOOK_SESSION_SECRET, else the key in `.housebook/session-key` (made on first use).

    A data root that can't be written gets a key for this run only, with a warning: sessions
    then end at every restart."""
    if secret:
        return hashlib.sha256(secret.encode()).digest()
    path = data_dir / KEY_FILE
    try:
        text = path.read_text(encoding="ascii").strip()
        if len(text) >= 64:
            return bytes.fromhex(text)
        log.warning("session key file is too short, making a new one", extra={"path": str(path)})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log.warning("session key file can't be read, making a new one", extra={"path": str(path), "error": str(e)})
    key = secrets.token_bytes(32)
    try:
        path.parent.mkdir(exist_ok=True)
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(key.hex() + "\n")
        os.replace(tmp, path)
    except OSError as e:
        log.warning(
            "can't save the session key; everyone is signed out when the server restarts "
            "(set HOUSEBOOK_SESSION_SECRET to avoid this)",
            extra={"path": str(path), "error": str(e)},
        )
    return key
