"""Settings from environment variables (see docs/configuration.md for the table)."""

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from housebook.domain.paths import is_ignored_name

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


class ConfigError(ValueError):
    pass


def _default_contract_dir() -> Path:
    # Repo checkout: apps/api/src/housebook/config.py -> <repo>/contract
    for parent in Path(__file__).resolve().parents:
        if (parent / "contract" / "catalog.json").is_file():
            return parent / "contract"
    return Path("/app/contract")


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("/data")
    notes_dir: str = "House"
    obsidian_vault: str | None = None
    obsidian_vault_subpath: str = ""
    tz: str = "UTC"
    auth_mode: Literal["none", "proxy", "oidc"] = "none"
    anon_role: Literal["viewer", "editor"] = "viewer"
    trusted_proxies: tuple[Network, ...] = ()
    editor_group: str = "housebook-editors"
    # Where "Log out" goes in proxy mode (oauth2-proxy's sign-out page by default).
    logout_url: str | None = None
    # oidc mode (D48): the app signs people in with the household's login provider itself.
    public_url: str | None = None  # https://house.example, without a trailing slash
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None  # None: a public client (PKCE only)
    oidc_scopes: str = "openid profile email"
    oidc_user_claim: str = "preferred_username"
    oidc_groups_claim: str = "groups"
    session_days: float = 30.0
    session_secret: str | None = None  # None: a random key kept in .housebook/session-key
    watch: Literal["inotify", "poll", "off"] = "inotify"
    poll_interval: float = 5.0  # seconds between polls with watch=poll
    rescan_interval: float = 600.0  # seconds; 0 disables
    sse_heartbeat: float = 20.0  # seconds between `: ping` comments on /api/events
    static_dir: Path | None = None
    contract_dir: Path = field(default_factory=_default_contract_dir)
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"

    @property
    def catalog_path(self) -> Path:
        return self.contract_dir / "catalog.json"

    @property
    def finishes_path(self) -> Path:
        return self.contract_dir / "finishes.json"

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = dict(os.environ if env is None else env)

        def get(name: str, default: str = "") -> str:
            return e.get(f"HOUSEBOOK_{name}", "").strip() or default  # empty = unset

        def secret(name: str) -> str | None:
            """HOUSEBOOK_<name>, or the contents of the file HOUSEBOOK_<name>_FILE (Docker secrets)."""
            if value := get(name):
                return value
            path = get(f"{name}_FILE")
            if not path:
                return None
            try:
                return Path(path).read_text(encoding="utf-8").strip() or None
            except OSError as ex:
                raise ConfigError(f"HOUSEBOOK_{name}_FILE: can't read '{path}' ({ex.strerror})") from None

        def choice[T: str](name: str, default: T, allowed: tuple[T, ...]) -> T:
            v = get(name, default).lower()
            if v not in allowed:
                raise ConfigError(f"HOUSEBOOK_{name} must be one of {', '.join(allowed)} (got '{v}')")
            return v  # type: ignore[return-value]

        # The notes folder must be a real subfolder: "." (the data root itself) is rejected, since
        # adoption and scanning are deliberately scoped to one folder, not the whole vault.
        raw_notes = get("NOTES_DIR", "House")
        parts = [p for p in raw_notes.replace("\\", "/").split("/") if p not in ("", ".")]
        if not parts or any(p == ".." for p in parts):
            raise ConfigError(
                f"HOUSEBOOK_NOTES_DIR must name a subfolder of the data dir, e.g. 'House' (got '{raw_notes}'); "
                "the data dir itself ('.') is not supported"
            )
        if any(is_ignored_name(p) for p in parts):
            raise ConfigError(
                f"HOUSEBOOK_NOTES_DIR '{raw_notes}' is a hidden or temporary folder name (dot-folders, '*~', "
                "'*.tmp', ...), which the scanner always skips; use a normal folder name such as 'House'"
            )
        notes_dir = "/".join(parts)

        tz = get("TZ") or e.get("TZ", "").strip() or "UTC"
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError):
            raise ConfigError(f"HOUSEBOOK_TZ: unknown time zone '{tz}'") from None

        auth_mode = choice("AUTH_MODE", "none", ("none", "proxy", "oidc"))

        proxies: list[Network] = []
        for part in filter(None, (p.strip() for p in get("TRUSTED_PROXIES").split(","))):
            try:
                proxies.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                raise ConfigError(f"HOUSEBOOK_TRUSTED_PROXIES: '{part}' is not an IP or CIDR") from None
        if auth_mode == "proxy" and not proxies:
            raise ConfigError(
                "HOUSEBOOK_AUTH_MODE=proxy needs HOUSEBOOK_TRUSTED_PROXIES (IPs/CIDRs of the auth proxy); "
                "identity headers from anyone else would be spoofable"
            )

        try:
            rescan = float(get("RESCAN_INTERVAL", "600"))
            poll = float(get("POLL_INTERVAL", "5"))
            port = int(get("PORT", "8000"))
            session_days = float(get("SESSION_DAYS", "30"))
        except ValueError as ex:
            raise ConfigError(f"invalid number: {ex}") from None
        if not 0.01 <= session_days <= 400:
            raise ConfigError(f"HOUSEBOOK_SESSION_DAYS must be between 0.01 and 400 (got {session_days:g})")

        public_url = _origin("PUBLIC_URL", get("PUBLIC_URL")) if get("PUBLIC_URL") else None
        issuer = get("OIDC_ISSUER").rstrip("/") or None
        client_id = get("OIDC_CLIENT_ID") or None
        if auth_mode == "oidc":
            missing = [
                f"HOUSEBOOK_{n}"
                for n, v in (("PUBLIC_URL", public_url), ("OIDC_ISSUER", issuer), ("OIDC_CLIENT_ID", client_id))
                if not v
            ]
            if missing:
                raise ConfigError(f"HOUSEBOOK_AUTH_MODE=oidc needs {', '.join(missing)} (see docs/login.md)")
            assert issuer is not None
            if urlsplit(issuer).scheme not in ("https", "http") or not urlsplit(issuer).netloc:
                raise ConfigError(f"HOUSEBOOK_OIDC_ISSUER must be an http(s) URL (got '{issuer}')")
            scopes = get("OIDC_SCOPES", "openid profile email").split()
            if "openid" not in scopes:
                raise ConfigError("HOUSEBOOK_OIDC_SCOPES must include 'openid'")

        if not 0.1 <= poll <= 3600:
            raise ConfigError(f"HOUSEBOOK_POLL_INTERVAL must be between 0.1 and 3600 seconds (got {poll:g})")

        static = get("STATIC_DIR")
        contract = get("CONTRACT_DIR")
        return cls(
            data_dir=Path(get("DATA_DIR", "/data")),
            notes_dir=notes_dir,
            obsidian_vault=get("OBSIDIAN_VAULT") or None,
            obsidian_vault_subpath=get("OBSIDIAN_VAULT_SUBPATH").strip("/"),
            tz=tz,
            auth_mode=auth_mode,
            anon_role=choice("ANON_ROLE", "viewer", ("viewer", "editor")),
            trusted_proxies=tuple(proxies),
            editor_group=get("EDITOR_GROUP", "housebook-editors"),
            logout_url=get("LOGOUT_URL") or None,
            public_url=public_url,
            oidc_issuer=issuer,
            oidc_client_id=client_id,
            oidc_client_secret=secret("OIDC_CLIENT_SECRET"),
            oidc_scopes=" ".join(get("OIDC_SCOPES", "openid profile email").split()),
            oidc_user_claim=get("OIDC_USER_CLAIM", "preferred_username"),
            oidc_groups_claim=get("OIDC_GROUPS_CLAIM", "groups"),
            session_days=session_days,
            session_secret=secret("SESSION_SECRET"),
            watch=choice("WATCH", "inotify", ("inotify", "poll", "off")),
            poll_interval=poll,
            rescan_interval=max(rescan, 0.0),
            static_dir=Path(static) if static else None,
            contract_dir=Path(contract) if contract else _default_contract_dir(),
            host=get("HOST", "0.0.0.0"),
            port=port,
            log_level=get("LOG_LEVEL", "INFO").upper(),
        )


def _origin(name: str, value: str) -> str:
    """An http(s) origin such as https://house.example (a trailing slash is dropped)."""
    parts = urlsplit(value.strip())
    if parts.scheme not in ("https", "http") or not parts.netloc or parts.path not in ("", "/") or parts.query:
        raise ConfigError(
            f"HOUSEBOOK_{name} must be the address people open, such as https://house.example, without a path "
            f"(got '{value}')"
        )
    return f"{parts.scheme}://{parts.netloc}"
