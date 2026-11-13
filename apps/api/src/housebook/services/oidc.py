"""OpenID Connect client for the built-in login (D48): authorization code flow with PKCE.

The provider is found through its discovery document (`<issuer>/.well-known/openid-configuration`,
cached for an hour). The ID token from the token endpoint is checked in full: signature against
the provider's published keys (refetched once when a token names an unknown key), issuer,
audience, expiry and nonce. Groups come from the ID token, or from the userinfo endpoint when
the token doesn't carry them (Authelia's default).

All calls are blocking (urllib); the routes that use them are plain `def`, which FastAPI runs in a
thread. Tests pass their own `Http`.
"""

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

from housebook import __version__
from housebook.config import Settings

DISCOVERY_TTL = 3600.0
TIMEOUT = 10.0
# Asymmetric algorithms only: a token signed with the shared client secret (HS256) isn't accepted.
ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]


class OidcError(Exception):
    """The provider couldn't be reached, or answered something unusable. The message is for logs
    and the error page; it never contains tokens or secrets."""


class Http(Protocol):
    def get_json(self, url: str, headers: dict[str, str] | None = None) -> Any: ...
    def post_form(self, url: str, form: dict[str, str], headers: dict[str, str] | None = None) -> Any: ...


class UrllibHttp:
    def _send(self, req: urllib.request.Request) -> Any:
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", f"housebook/{__version__}")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:  # noqa: S310 (configured http(s) URLs)
                return json.loads(res.read(1024 * 1024))
        except urllib.error.HTTPError as e:
            raise OidcError(f"{req.get_method()} {req.full_url}: {e.code} {_error_text(e)}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise OidcError(f"{req.get_method()} {req.full_url}: {getattr(e, 'reason', e)}") from None
        except ValueError:
            raise OidcError(f"{req.get_method()} {req.full_url}: not JSON") from None

    def get_json(self, url: str, headers: dict[str, str] | None = None) -> Any:
        return self._send(urllib.request.Request(url, headers=headers or {}))

    def post_form(self, url: str, form: dict[str, str], headers: dict[str, str] | None = None) -> Any:
        body = urllib.parse.urlencode(form).encode()
        h = {"Content-Type": "application/x-www-form-urlencoded", **(headers or {})}
        return self._send(urllib.request.Request(url, data=body, headers=h, method="POST"))


def _error_text(e: urllib.error.HTTPError) -> str:
    """`error` / `error_description` of an OAuth error body, else the status text."""
    try:
        body = json.loads(e.read(4096))
        parts = [str(body.get(k)) for k in ("error", "error_description") if body.get(k)]
        if parts:
            return ": ".join(parts)[:300]
    except (ValueError, OSError, AttributeError):
        pass
    return str(e.reason)


@dataclass(frozen=True)
class Provider:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    userinfo_endpoint: str | None
    end_session_endpoint: str | None


@dataclass(frozen=True)
class LoginStart:
    url: str
    state: str
    nonce: str
    verifier: str


@dataclass(frozen=True)
class Person:
    user: str
    name: str | None
    groups: tuple[str, ...]


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")


class Oidc:
    def __init__(self, settings: Settings, http: Http | None = None, clock: Callable[[], float] = time.time) -> None:
        assert settings.oidc_issuer and settings.oidc_client_id and settings.public_url
        self.settings = settings
        self.issuer = settings.oidc_issuer
        self.client_id = settings.oidc_client_id
        self.redirect_uri = f"{settings.public_url}/api/auth/callback"
        self.http = http or UrllibHttp()
        self.clock = clock
        self._lock = threading.Lock()
        self._provider: tuple[float, Provider] | None = None
        self._keys: dict[str, jwt.PyJWK] = {}

    # ---- provider -----------------------------------------------------------------------------

    def provider(self) -> Provider:
        with self._lock:
            if self._provider and self.clock() - self._provider[0] < DISCOVERY_TTL:
                return self._provider[1]
        doc = self.http.get_json(f"{self.issuer}/.well-known/openid-configuration")
        if not isinstance(doc, dict):
            raise OidcError("discovery document is not a JSON object")
        # OIDC Discovery §4.3: the document must name exactly the configured issuer.
        if str(doc.get("issuer", "")).rstrip("/") != self.issuer:
            raise OidcError(f"discovery names issuer '{doc.get('issuer')}', not HOUSEBOOK_OIDC_ISSUER '{self.issuer}'")
        try:
            p = Provider(
                issuer=str(doc["issuer"]),
                authorization_endpoint=str(doc["authorization_endpoint"]),
                token_endpoint=str(doc["token_endpoint"]),
                jwks_uri=str(doc["jwks_uri"]),
                userinfo_endpoint=str(doc["userinfo_endpoint"]) if doc.get("userinfo_endpoint") else None,
                end_session_endpoint=str(doc["end_session_endpoint"]) if doc.get("end_session_endpoint") else None,
            )
        except KeyError as e:
            raise OidcError(f"discovery document has no {e.args[0]}") from None
        with self._lock:
            self._provider = (self.clock(), p)
        return p

    def _key(self, kid: str | None) -> jwt.PyJWK:
        def lookup() -> jwt.PyJWK | None:
            if kid is not None:
                return self._keys.get(kid)
            return next(iter(self._keys.values())) if len(self._keys) == 1 else None

        with self._lock:
            if key := lookup():
                return key
        # Unknown key: the provider may have rotated its keys.
        jwks = self.http.get_json(self.provider().jwks_uri)
        try:
            keys = {k.key_id or "": k for k in jwt.PyJWKSet.from_dict(jwks).keys if k.public_key_use in (None, "sig")}
        except (jwt.PyJWKSetError, jwt.InvalidKeyError, TypeError, AttributeError) as e:
            raise OidcError(f"the provider's keys can't be read: {e}") from None
        with self._lock:
            self._keys = keys
            if key := lookup():
                return key
        raise OidcError("the ID token is signed with a key the provider doesn't publish")

    # ---- the flow -----------------------------------------------------------------------------

    def start(self) -> LoginStart:
        state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
        query = urllib.parse.urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": self.settings.oidc_scopes,
                "state": state,
                "nonce": nonce,
                "code_challenge": pkce_challenge(verifier),
                "code_challenge_method": "S256",
            }
        )
        endpoint = self.provider().authorization_endpoint
        sep = "&" if "?" in endpoint else "?"
        return LoginStart(url=f"{endpoint}{sep}{query}", state=state, nonce=nonce, verifier=verifier)

    def finish(self, code: str, verifier: str, nonce: str) -> Person:
        """Exchange the code, check the ID token and return who signed in."""
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "code_verifier": verifier,
            "client_id": self.client_id,
        }
        headers: dict[str, str] = {}
        if secret := self.settings.oidc_client_secret:
            # client_secret_basic: the default every provider supports (RFC 6749 §2.3.1).
            q = urllib.parse.quote
            basic = base64.b64encode(f"{q(self.client_id, safe='')}:{q(secret, safe='')}".encode()).decode()
            headers["Authorization"] = f"Basic {basic}"
        tokens = self.http.post_form(self.provider().token_endpoint, form, headers)
        if not isinstance(tokens, dict) or not isinstance(tokens.get("id_token"), str):
            raise OidcError("the token endpoint sent no ID token (is 'openid' in HOUSEBOOK_OIDC_SCOPES?)")
        claims = self.verify_id_token(tokens["id_token"], nonce)
        if self.settings.oidc_groups_claim not in claims:
            claims = {**self._userinfo(tokens.get("access_token"), claims["sub"]), **claims}
        return self.person(claims)

    def verify_id_token(self, token: str, nonce: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as e:
            raise OidcError(f"the ID token can't be read: {e}") from None
        alg = header.get("alg")
        if alg not in ALGORITHMS:
            raise OidcError(f"the ID token uses algorithm '{alg}', which isn't accepted")
        key = self._key(header.get("kid"))
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key=key,
                algorithms=[alg],
                audience=self.client_id,
                issuer=self.provider().issuer,
                leeway=60,
                options={"require": ["iss", "sub", "aud", "exp", "iat"]},
            )
        except jwt.InvalidTokenError as e:
            raise OidcError(f"the ID token was rejected: {e}") from None
        if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
            raise OidcError("the ID token's nonce doesn't match this login")
        # More than one audience: we must be the one it was issued to (OIDC Core §3.1.3.7).
        if isinstance(claims.get("aud"), list) and len(claims["aud"]) > 1 and claims.get("azp") != self.client_id:
            raise OidcError("the ID token was issued to another client")
        return claims

    def _userinfo(self, access_token: object, sub: str) -> dict[str, Any]:
        endpoint = self.provider().userinfo_endpoint
        if not endpoint or not isinstance(access_token, str):
            return {}
        info = self.http.get_json(endpoint, {"Authorization": f"Bearer {access_token}"})
        # OIDC Core §5.3.2: userinfo about anyone else must not be used.
        if not isinstance(info, dict) or info.get("sub") != sub:
            raise OidcError("the userinfo answer is about someone else")
        return info

    def person(self, claims: dict[str, Any]) -> Person:
        s = self.settings
        user = next(
            (str(v) for k in (s.oidc_user_claim, "preferred_username", "email", "sub") if (v := claims.get(k))),
            "",
        )
        raw = claims.get(s.oidc_groups_claim)
        groups = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
        name = claims.get("name")
        return Person(
            user=user,
            name=str(name) if name else None,
            groups=tuple(str(g) for g in groups if isinstance(g, str | int)),
        )

    def logout_url(self) -> str | None:
        """The provider's logout page, coming back to Housebook afterwards (RP-initiated
        logout); None when the provider has none or can't be reached."""
        try:
            endpoint = self.provider().end_session_endpoint
        except OidcError:
            return None
        if not endpoint:
            return None
        query = urllib.parse.urlencode(
            {"client_id": self.client_id, "post_logout_redirect_uri": f"{self.settings.public_url}/"}
        )
        return f"{endpoint}{'&' if '?' in endpoint else '?'}{query}"
