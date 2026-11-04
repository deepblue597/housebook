"""Identity and role (DESIGN 9, 15.13).

- none:  no login; everyone gets HOUSEBOOK_ANON_ROLE (viewer unless set to editor explicitly).
- proxy: oauth2-proxy (or similar) in front. X-Forwarded-User / X-Forwarded-Groups are
         trusted only when the TCP peer is in HOUSEBOOK_TRUSTED_PROXIES. Uvicorn runs with
         proxy_headers off, so request.client is the real peer, not X-Forwarded-For.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, Request, status

from housebook.config import Settings

Role = Literal["viewer", "editor"]


@dataclass(frozen=True)
class Identity:
    user: str | None
    role: Role
    groups: tuple[str, ...] = ()


def _peer_trusted(request: Request, settings: Settings) -> bool:
    host = request.client.host if request.client else None
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:  # e.g. "testclient" or a unix socket
        return False
    return any(ip in net for net in settings.trusted_proxies)


def identify(request: Request, settings: Settings) -> Identity:
    if settings.auth_mode == "none":
        return Identity(user=None, role=settings.anon_role)

    if not _peer_trusted(request, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    user = request.headers.get("x-forwarded-user", "").strip()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    raw_groups = request.headers.get("x-forwarded-groups", "")
    groups = tuple(g.strip() for g in raw_groups.split(",") if g.strip())
    role: Role = "editor" if any(is_editor_group(g, settings.editor_group) for g in groups) else "viewer"
    return Identity(user=user, role=role, groups=groups)


def is_editor_group(group: str, editor_group: str) -> bool:
    """Case-sensitive, like Keycloak group names.

    - Full path (`/home/housebook-editors`): that exact group only. The stricter option.
    - Bare name (`housebook-editors`): a group with that name at any depth, so
      `housebook-editors`, `/housebook-editors` and `/kids/housebook-editors` all match."""
    if editor_group.startswith("/"):
        return group == editor_group
    return group.lstrip("/") == editor_group or group.endswith("/" + editor_group)
