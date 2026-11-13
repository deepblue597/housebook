"""The built-in login (HOUSEBOOK_AUTH_MODE=oidc, D48): /api/auth/login, /callback, /logout.

- login: remembers a random state, nonce and PKCE verifier in a signed, short-lived cookie and
  sends the browser to the provider.
- callback: checks the state against that cookie, exchanges the code, checks the ID token
  (services/oidc.py) and sets the session cookie; then back to the page the person wanted.
- logout: deletes the session cookie and, when the provider supports it, ends the provider's
  session too (else the next visit would sign straight back in).

In other modes these routes answer 404. Page loads without a session are sent to login by the
SPA fallback (api/spa.py), API calls get 401 (api/auth.py).
"""

import hmac
import html
import logging
import re
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from housebook.api.auth import SESSION_COOKIE, role_of
from housebook.api.context import AppContext, get_ctx
from housebook.services.oidc import Oidc, OidcError
from housebook.services.sessions import Session, Sessions, Signer

log = logging.getLogger(__name__)

LOGIN_COOKIE = "housebook_login"
LOGIN_TTL = 600  # seconds to finish signing in at the provider
AUTH_PATH = "/api/auth"

login = APIRouter(prefix=AUTH_PATH, include_in_schema=False)
Ctx = Annotated[AppContext, Depends(get_ctx)]

# A local path: one leading slash, no scheme, no `//host` or `/\host`, no control characters.
_LOCAL = re.compile(r"^/(?![/\\])[^\x00-\x1f\x7f]*$")


def safe_next(target: str | None) -> str:
    """Where to go after signing in: a path on this site, never another site (open redirect)
    and never back into the login itself."""
    if not target or not _LOCAL.match(target) or target.startswith(AUTH_PATH):
        return "/"
    return target


def login_url(target: str) -> str:
    return f"{AUTH_PATH}/login?next={quote(safe_next(target), safe='')}"


def _parts(ctx: AppContext) -> tuple[Oidc, Signer, Sessions]:
    if ctx.oidc is None or ctx.signer is None or ctx.sessions is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return ctx.oidc, ctx.signer, ctx.sessions


def _secure(ctx: AppContext) -> bool:
    return (ctx.settings.public_url or "").startswith("https://")


def _page(code: int, title: str, text: str, retry: str | None = None) -> HTMLResponse:
    link = f'<p><a href="{html.escape(retry)}">Try again</a></p>' if retry else ""
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{html.escape(title)} · Housebook</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px}}</style>
</head><body><h1>{html.escape(title)}</h1><p>{html.escape(text)}</p>{link}</body></html>
"""
    return HTMLResponse(body, status_code=code, headers={"Cache-Control": "no-store"})


@login.get("/login")
def start_login(ctx: Ctx, next: str | None = None) -> Response:
    oidc, signer, _ = _parts(ctx)
    target = safe_next(next)
    try:
        start = oidc.start()
    except OidcError as e:
        log.error("login provider unreachable", extra={"error": str(e)})
        return _page(
            502,
            "Can’t reach the login provider",
            "Housebook couldn’t reach the login provider. Check that it is running, then try again.",
            login_url(target),
        )
    cookie = signer.sign("login", {"s": start.state, "n": start.nonce, "v": start.verifier, "t": target}, LOGIN_TTL)
    res = RedirectResponse(start.url, status_code=status.HTTP_302_FOUND)
    res.set_cookie(
        LOGIN_COOKIE, cookie, max_age=LOGIN_TTL, path=AUTH_PATH, httponly=True, samesite="lax", secure=_secure(ctx)
    )
    return res


@login.get("/callback")
def finish_login(
    request: Request,
    ctx: Ctx,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> Response:
    oidc, signer, sessions = _parts(ctx)
    pending = signer.unsign("login", request.cookies.get(LOGIN_COOKIE))
    target = safe_next(pending.get("t") if pending else None)
    if error:
        log.warning("login refused by the provider", extra={"error": error, "description": error_description})
        res: Response = _page(
            400, "Not signed in", f"The login provider said: {error_description or error}.", login_url(target)
        )
    elif pending is None or not state or not hmac.compare_digest(state, str(pending.get("s"))) or not code:
        # Expired (over 10 minutes), opened in another browser, or a second login tab won.
        res = _page(400, "Not signed in", "This login took too long or was started elsewhere.", login_url(target))
    else:
        try:
            person = oidc.finish(code, str(pending["v"]), str(pending["n"]))
        except OidcError as e:
            log.error("login failed", extra={"error": str(e)})
            return _page(502, "Not signed in", "The login provider’s answer couldn’t be used.", login_url(target))
        if not person.user:
            return _page(400, "Not signed in", "The login provider didn’t say who you are.", login_url(target))
        # Only the groups that grant a role are kept: the cookie stays small whatever the
        # provider sends (changing HOUSEBOOK_EDITOR_GROUP then needs a new login).
        groups = tuple(g for g in person.groups if role_of((g,), ctx.settings) == "editor")
        token = sessions.issue(Session(user=person.user, name=person.name, groups=groups))
        log.info("login", extra={"user": person.user, "role": role_of(groups, ctx.settings)})
        res = RedirectResponse(target, status_code=status.HTTP_302_FOUND)
        res.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=sessions.max_age,
            path="/",
            httponly=True,
            samesite="lax",
            secure=_secure(ctx),
        )
    res.delete_cookie(LOGIN_COOKIE, path=AUTH_PATH, httponly=True, samesite="lax", secure=_secure(ctx))
    return res


@login.get("/logout")
def logout(ctx: Ctx) -> Response:
    oidc, _, _ = _parts(ctx)
    res = RedirectResponse(oidc.logout_url() or "/", status_code=status.HTTP_302_FOUND)
    res.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=_secure(ctx))
    return res
