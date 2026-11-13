"""The built-in login (HOUSEBOOK_AUTH_MODE=oidc, D48), end to end against a fake provider that
signs real RS256 ID tokens."""

import base64
import hashlib
import os
import stat
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from conftest import NOW, ClientFactory
from housebook.api.login import safe_next
from housebook.config import ConfigError, Settings
from housebook.services.oidc import OidcError
from housebook.services.sessions import KEY_FILE, Session, Sessions, Signer, session_key

ISSUER = "https://sso.example/realms/home"
PUBLIC = "https://house.example"
CLIENT = "housebook"
SECRET = "s3cr:t"


def new_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk(key: rsa.RSAPrivateKey, kid: str) -> dict[str, Any]:
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    return {**jwk, "kid": kid, "use": "sig", "alg": "RS256"}


@dataclass
class FakeProvider:
    """Discovery, keys, token and userinfo endpoints; records what it was sent."""

    key: rsa.RSAPrivateKey = field(default_factory=new_key)
    kid: str = "k1"
    issuer: str = ISSUER
    claims: dict[str, Any] = field(
        default_factory=lambda: {"sub": "u-1", "preferred_username": "anna", "name": "Anna", "groups": []}
    )
    userinfo: dict[str, Any] | None = None
    end_session: bool = True
    codes: dict[str, dict[str, Any]] = field(default_factory=dict)
    token_requests: list[tuple[dict[str, str], dict[str, str]]] = field(default_factory=list)
    gets: list[str] = field(default_factory=list)
    tamper: dict[str, Any] = field(default_factory=dict)

    def get_json(self, url: str, headers: dict[str, str] | None = None) -> Any:
        self.gets.append(url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            doc = {
                "issuer": self.issuer,
                "authorization_endpoint": "https://sso.example/auth",
                "token_endpoint": "https://sso.example/token",
                "jwks_uri": "https://sso.example/certs",
                "userinfo_endpoint": "https://sso.example/userinfo",
            }
            if self.end_session:
                doc["end_session_endpoint"] = "https://sso.example/logout"
            return doc
        if url == "https://sso.example/certs":
            return {"keys": [_jwk(self.key, self.kid)]}
        if url == "https://sso.example/userinfo":
            assert (headers or {}).get("Authorization") == "Bearer at-1"
            return self.userinfo
        raise OidcError(f"unexpected GET {url}")

    def post_form(self, url: str, form: dict[str, str], headers: dict[str, str] | None = None) -> Any:
        assert url == "https://sso.example/token"
        self.token_requests.append((form, headers or {}))
        grant = self.codes.pop(form["code"], None)
        if grant is None:
            raise OidcError("POST token: 400 invalid_grant")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).rstrip(b"=")
        if challenge.decode() != grant["challenge"]:
            raise OidcError("POST token: 400 invalid_grant: PKCE")
        now = int(time.time())
        claims = {
            "iss": ISSUER,
            "aud": CLIENT,
            "iat": now,
            "exp": now + 300,
            "nonce": grant["nonce"],
            **self.claims,
            **self.tamper,
        }
        token = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": self.kid})
        return {"id_token": token, "access_token": "at-1", "token_type": "Bearer"}

    def authorize(self, url: str) -> str:
        """The provider's login page: the person signs in; returns the code for the callback."""
        q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        assert q["client_id"] == CLIENT and q["redirect_uri"] == f"{PUBLIC}/api/auth/callback"
        assert q["response_type"] == "code" and q["code_challenge_method"] == "S256"
        code = f"code-{len(self.codes)}"
        self.codes[code] = {"nonce": q["nonce"], "challenge": q["code_challenge"]}
        return code


@pytest.fixture
def idp() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def spa(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Housebook</title>")
    (web / "assets" / "index-abcdef12.js").write_text("console.log(1)")
    (web / "manifest.webmanifest").write_text("{}")
    return web


@pytest.fixture
def oidc(example_root: Path, make_client: ClientFactory, idp: FakeProvider, spa: Path):
    def factory(**overrides: object) -> TestClient:
        settings: dict[str, object] = {
            "auth_mode": "oidc",
            "public_url": PUBLIC,
            "oidc_issuer": ISSUER,
            "oidc_client_id": CLIENT,
            "oidc_client_secret": SECRET,
            "static_dir": spa,
            **overrides,
        }
        c = make_client(example_root, **settings)
        c.base_url = PUBLIC  # type: ignore[assignment]  # cookies are Secure on https
        c.app.state.ctx.oidc.http = idp  # type: ignore[attr-defined]
        return c

    return factory


def sign_in(c: TestClient, idp: FakeProvider, next: str = "/") -> Any:
    r = c.get("/api/auth/login", params={"next": next}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("https://sso.example/auth?")
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    code = idp.authorize(r.headers["location"])
    return c.get("/api/auth/callback", params={"code": code, "state": state}, follow_redirects=False)


# --- the flow ---------------------------------------------------------------------------------------


def test_page_loads_without_a_session_go_to_the_login(oidc):
    c = oidc()
    r = c.get("/i/it_7f3k2a?x=1", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/api/auth/login?next=%2Fi%2Fit_7f3k2a%3Fx%3D1"
    assert c.get("/api/me").status_code == 401
    assert c.get("/api/snapshot").status_code == 401
    assert c.post("/api/items/it_7f3k2a/log", json={"text": "x"}).status_code == 401
    # The app's own files need no login (the service worker and manifest are fetched without one).
    assert c.get("/assets/index-abcdef12.js").status_code == 200
    assert c.get("/manifest.webmanifest").status_code == 200
    assert c.get("/readyz").status_code == 200


def test_sign_in_and_out(oidc, idp: FakeProvider):
    idp.claims["groups"] = ["/family", "/home/housebook-editors"]
    c = oidc()
    r = sign_in(c, idp, next="/i/it_7f3k2a?x=1")
    assert r.status_code == 302 and r.headers["location"] == "/i/it_7f3k2a?x=1"
    cookie = r.headers["set-cookie"]
    assert "housebook_session=" in cookie and "HttpOnly" in cookie and "Secure" in cookie
    assert "SameSite=lax" in cookie and "Max-Age=2592000" in cookie

    assert c.get("/api/me").json() == {
        "user": "anna",
        "name": "Anna",
        "role": "editor",
        "authMode": "oidc",
        "logoutUrl": "/api/auth/logout",
    }
    assert c.get("/", follow_redirects=False).status_code == 200
    assert c.post("/api/items/it_7f3k2a/log", json={"text": "Descaled"}).status_code == 200

    # PKCE and client_secret_basic were used for the code.
    form, headers = idp.token_requests[0]
    assert form["grant_type"] == "authorization_code" and form["code_verifier"]
    assert headers["Authorization"] == "Basic " + base64.b64encode(b"housebook:s3cr%3At").decode()

    r = c.get("/api/auth/logout", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == (
        "https://sso.example/logout?client_id=housebook&post_logout_redirect_uri=https%3A%2F%2Fhouse.example%2F"
    )
    assert 'housebook_session=""' in r.headers["set-cookie"] and "Max-Age=0" in r.headers["set-cookie"]
    assert c.get("/api/me").status_code == 401


def test_viewer_without_the_editor_group(oidc, idp: FakeProvider):
    idp.claims["groups"] = ["/family", "/kids/housebook-editors-not"]
    c = oidc(editor_group="/home/housebook-editors")
    sign_in(c, idp)
    assert c.get("/api/me").json()["role"] == "viewer"
    assert c.post("/api/items/it_7f3k2a/log", json={"text": "x"}).status_code == 403


def test_groups_from_userinfo_when_the_id_token_has_none(oidc, idp: FakeProvider):
    del idp.claims["groups"]
    idp.userinfo = {"sub": "u-1", "groups": ["housebook-editors"], "name": "Not used"}
    c = oidc()
    sign_in(c, idp)
    me = c.get("/api/me").json()
    assert me["role"] == "editor" and me["name"] == "Anna"  # ID token claims win


def test_userinfo_about_someone_else_is_refused(oidc, idp: FakeProvider):
    del idp.claims["groups"]
    idp.userinfo = {"sub": "someone-else", "groups": ["housebook-editors"]}
    c = oidc()
    r = sign_in(c, idp)
    assert r.status_code == 502 and "Not signed in" in r.text
    assert c.get("/api/me").status_code == 401


def test_user_falls_back_to_email_then_sub(oidc, idp: FakeProvider):
    idp.claims = {"sub": "u-9", "email": "bo@example.org"}
    idp.userinfo = {"sub": "u-9"}  # no groups anywhere: a viewer
    c = oidc()
    sign_in(c, idp)
    assert c.get("/api/me").json()["user"] == "bo@example.org"
    assert c.get("/api/me").json()["name"] == "bo@example.org"


def test_a_public_client_sends_no_secret(oidc, idp: FakeProvider):
    c = oidc(oidc_client_secret=None)
    assert sign_in(c, idp).status_code == 302
    form, headers = idp.token_requests[0]
    assert "Authorization" not in headers and form["client_id"] == CLIENT


def test_plain_http_public_url_gets_no_secure_flag(oidc):
    c = oidc(public_url="http://house.lan")
    c.base_url = "http://house.lan"  # type: ignore[assignment]
    r = c.get("/api/auth/login", follow_redirects=False)
    assert "Secure" not in r.headers["set-cookie"]
    assert parse_qs(urlsplit(r.headers["location"]).query)["redirect_uri"] == ["http://house.lan/api/auth/callback"]


# --- what is refused -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tamper, why",
    [
        ({"aud": "another-app"}, "audience"),
        ({"iss": "https://evil.example"}, "issuer"),
        ({"exp": int(time.time()) - 3600}, "expired"),
        ({"nonce": "replayed"}, "nonce"),
        ({"aud": [CLIENT, "other"], "azp": "other"}, "another client"),
    ],
)
def test_bad_id_tokens_are_refused(oidc, idp: FakeProvider, tamper: dict, why: str):
    idp.tamper = tamper
    c = oidc()
    r = sign_in(c, idp)
    assert r.status_code == 502, why
    assert "housebook_session" not in r.headers.get("set-cookie", "")
    assert c.get("/api/me").status_code == 401


def test_a_token_signed_with_another_key_is_refused(oidc, idp: FakeProvider):
    c = oidc()
    sign_in(c, idp)  # the provider's key is fetched and kept
    c.cookies.clear()
    idp.key = new_key()  # same kid, wrong key
    assert sign_in(c, idp).status_code == 502
    assert c.get("/api/me").status_code == 401


def test_rotated_keys_are_fetched_again(oidc, idp: FakeProvider):
    c = oidc()
    sign_in(c, idp)
    idp.key, idp.kid = new_key(), "k2"
    c.cookies.clear()
    assert sign_in(c, idp).status_code == 302
    assert idp.gets.count("https://sso.example/certs") == 2


def test_state_must_match_the_login_cookie(oidc, idp: FakeProvider):
    c = oidc()
    r = c.get("/api/auth/login", follow_redirects=False)
    code = idp.authorize(r.headers["location"])
    r = c.get("/api/auth/callback", params={"code": code, "state": "forged"}, follow_redirects=False)
    assert r.status_code == 400 and "took too long or was started elsewhere" in r.text
    assert "/api/auth/login?next=%2F" in r.text
    # Another browser (no login cookie) can't finish someone else's login.
    c.cookies.clear()
    state = parse_qs(urlsplit(c.get("/api/auth/login", follow_redirects=False).headers["location"]).query)["state"]
    c.cookies.clear()
    r = c.get("/api/auth/callback", params={"code": code, "state": state[0]}, follow_redirects=False)
    assert r.status_code == 400


def test_the_login_cookie_expires(oidc, idp: FakeProvider):
    c = oidc()
    r = c.get("/api/auth/login", follow_redirects=False)
    state = parse_qs(urlsplit(r.headers["location"]).query)["state"][0]
    code = idp.authorize(r.headers["location"])
    c.app.state.ctx.signer._clock = lambda: NOW + timedelta(minutes=11)  # type: ignore[attr-defined]
    r = c.get("/api/auth/callback", params={"code": code, "state": state}, follow_redirects=False)
    assert r.status_code == 400


def test_provider_errors_are_shown_not_raised(oidc, idp: FakeProvider):
    c = oidc()
    c.get("/api/auth/login", follow_redirects=False)
    r = c.get("/api/auth/callback", params={"error": "access_denied", "error_description": "User <b>"})
    assert r.status_code == 400 and "User &lt;b&gt;" in r.text


def test_a_discovery_document_for_another_issuer_is_refused(oidc, idp: FakeProvider):
    idp.issuer = "https://elsewhere.example"
    r = oidc().get("/api/auth/login", follow_redirects=False)
    assert r.status_code == 502 and "Can’t reach the login provider" in r.text


def test_logout_without_end_session_goes_home(oidc, idp: FakeProvider):
    idp.end_session = False
    c = oidc()
    sign_in(c, idp)
    assert c.get("/api/auth/logout", follow_redirects=False).headers["location"] == "/"


@pytest.mark.parametrize(
    "target, expected",
    [
        ("/i/it_1?x=1", "/i/it_1?x=1"),
        ("//evil.example/", "/"),
        ("/\\evil.example", "/"),
        ("https://evil.example/", "/"),
        ("evil", "/"),
        ("/api/auth/logout", "/"),
        ("/a\nb", "/"),
        (None, "/"),
    ],
)
def test_next_stays_on_this_site(target: str | None, expected: str):
    assert safe_next(target) == expected


def test_login_routes_are_404_in_other_modes(client: TestClient):
    assert client.get("/api/auth/login", follow_redirects=False).status_code == 404
    assert client.get("/api/auth/logout", follow_redirects=False).status_code == 404


def test_a_forged_or_altered_session_cookie_is_refused(oidc, idp: FakeProvider):
    c = oidc()
    sign_in(c, idp)
    token = c.cookies.get("housebook_session")
    assert token
    _, mac = token.split(".")
    forged = base64.urlsafe_b64encode(b'{"u":"admin","n":null,"g":["housebook-editors"],"exp":9999999999}')
    c.cookies.clear()
    for cookie in (f"{forged.decode().rstrip('=')}.{mac}", token[:-2] + "AA", "garbage"):
        assert c.get("/api/me", headers={"Cookie": f"housebook_session={cookie}"}).status_code == 401
    assert c.get("/api/me", headers={"Cookie": f"housebook_session={token}"}).status_code == 200


# --- sessions and settings -------------------------------------------------------------------------


def test_signed_values_expire_and_keep_to_their_purpose():
    now = [datetime(2026, 1, 1, tzinfo=UTC)]
    signer = Signer(b"k" * 32, lambda: now[0])
    token = signer.sign("login", {"a": 1}, ttl=60)
    assert signer.unsign("login", token) == {"a": 1, "exp": int(now[0].timestamp()) + 60}
    assert signer.unsign("session", token) is None
    assert Signer(b"x" * 32).unsign("login", token) is None
    for bad in (None, "", "a", "a.b.c", token + "x"):
        assert signer.unsign("login", bad) is None
    now[0] += timedelta(seconds=61)
    assert signer.unsign("login", token) is None


def test_sessions_round_trip():
    sessions = Sessions(Signer(b"k" * 32), days=1)
    token = sessions.issue(Session(user="anna", name=None, groups=("g",)))
    assert sessions.read(token) == Session(user="anna", name=None, groups=("g",))
    assert sessions.max_age == 86400


def test_session_key_is_kept_private_and_stable(tmp_path: Path):
    first = session_key(None, tmp_path)
    assert session_key(None, tmp_path) == first and len(first) == 32
    assert stat.S_IMODE(os.stat(tmp_path / KEY_FILE).st_mode) == 0o600
    assert session_key("from-env", tmp_path) == hashlib.sha256(b"from-env").digest()


def test_session_key_on_a_read_only_root(tmp_path: Path):
    tmp_path.chmod(0o500)
    try:
        assert len(session_key(None, tmp_path)) == 32  # for this run only, with a warning
    finally:
        tmp_path.chmod(0o700)


def _oidc_env(**extra: str) -> dict[str, str]:
    return {
        "HOUSEBOOK_AUTH_MODE": "oidc",
        "HOUSEBOOK_PUBLIC_URL": "https://house.example/",
        "HOUSEBOOK_OIDC_ISSUER": "https://sso.example/realms/home/",
        "HOUSEBOOK_OIDC_CLIENT_ID": "housebook",
        **extra,
    }


def test_oidc_settings(tmp_path: Path):
    secret = tmp_path / "secret"
    secret.write_text("from-file\n")
    s = Settings.from_env(_oidc_env(HOUSEBOOK_OIDC_CLIENT_SECRET_FILE=str(secret), HOUSEBOOK_SESSION_DAYS="7"))
    assert s.public_url == "https://house.example"
    assert s.oidc_issuer == "https://sso.example/realms/home"
    assert s.oidc_client_secret == "from-file"
    assert s.session_days == 7 and s.oidc_scopes == "openid profile email"
    assert Settings.from_env(_oidc_env(HOUSEBOOK_OIDC_CLIENT_SECRET="direct")).oidc_client_secret == "direct"


@pytest.mark.parametrize(
    "extra, message",
    [
        ({"HOUSEBOOK_PUBLIC_URL": "https://house.example/app"}, "without a path"),
        ({"HOUSEBOOK_PUBLIC_URL": "house.example"}, "without a path"),
        ({"HOUSEBOOK_OIDC_ISSUER": "sso.example"}, "http(s) URL"),
        ({"HOUSEBOOK_OIDC_SCOPES": "profile email"}, "'openid'"),
        ({"HOUSEBOOK_SESSION_DAYS": "0"}, "SESSION_DAYS"),
        ({"HOUSEBOOK_OIDC_CLIENT_SECRET_FILE": "/nonexistent/secret"}, "can't read"),
        ({"HOUSEBOOK_OIDC_CLIENT_ID": ""}, "needs HOUSEBOOK_OIDC_CLIENT_ID"),
    ],
)
def test_oidc_settings_errors(extra: dict[str, str], message: str):
    with pytest.raises(ConfigError, match=message.replace("(", r"\(").replace(")", r"\)")):
        Settings.from_env(_oidc_env(**extra))
