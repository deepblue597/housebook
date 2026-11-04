import ipaddress
from pathlib import Path

import pytest

from housebook.config import ConfigError, Settings
from housebook.domain.catalog import Catalog
from housebook.lock import LockHeld, ProcessLock

PROTOTYPE_TYPES = {
    "fridge", "oven", "dishwasher", "washer", "dryer", "microwave", "ac", "heater",
    "radiator", "tv", "router", "valve", "fuse", "smoke", "other",
}  # fmt: skip


def test_catalog_covers_prototype_and_resolves_aliases(catalog: Catalog):
    assert {t.key for t in catalog.types} >= PROTOTYPE_TYPES
    assert catalog.resolve("Washing_Machine").key == "washer"
    assert catalog.resolve("fuse").critical and catalog.resolve("valve").critical
    assert catalog.resolve("spaceship") is None and catalog.resolve(None) is None
    assert all(t.footprint == (1, 1) for t in catalog.types)


def test_catalog_rejects_alias_collisions():
    t = {"key": "a", "label": "A", "defaultName": "A", "mount": "floor"}
    with pytest.raises(ValueError, match="defined twice"):
        Catalog.model_validate({"types": [t, {**t, "key": "b", "aliases": ["a"]}]})


def test_settings_from_env_defaults():
    s = Settings.from_env({})
    assert s.data_dir == Path("/data") and s.notes_dir == "House" and s.tz == "UTC"
    assert s.auth_mode == "none" and s.anon_role == "viewer" and s.rescan_interval == 600


def test_settings_from_env_values():
    s = Settings.from_env(
        {
            "HOUSEBOOK_DATA_DIR": "/vault/Housebook",
            "HOUSEBOOK_NOTES_DIR": "/Notes/",
            "TZ": "Europe/Athens",
            "HOUSEBOOK_AUTH_MODE": "proxy",
            "HOUSEBOOK_TRUSTED_PROXIES": "10.0.0.5, 172.16.0.0/12",
            "HOUSEBOOK_WATCH": "poll",
            "HOUSEBOOK_OBSIDIAN_VAULT": "homepage",
            "HOUSEBOOK_OBSIDIAN_VAULT_SUBPATH": "/Housebook/",
        }
    )
    assert s.notes_dir == "Notes" and s.tz == "Europe/Athens" and s.watch == "poll"
    assert ipaddress.ip_address("172.20.1.1") in s.trusted_proxies[1]
    assert s.obsidian_vault_subpath == "Housebook"


@pytest.mark.parametrize(
    "env, message",
    [
        ({"HOUSEBOOK_AUTH_MODE": "proxy"}, "TRUSTED_PROXIES"),
        ({"HOUSEBOOK_AUTH_MODE": "oidc"}, "not implemented"),
        ({"HOUSEBOOK_AUTH_MODE": "basic"}, "AUTH_MODE"),
        ({"HOUSEBOOK_ANON_ROLE": "admin"}, "ANON_ROLE"),
        ({"HOUSEBOOK_TZ": "Mars/Base"}, "time zone"),
        ({"HOUSEBOOK_NOTES_DIR": "../escape"}, "NOTES_DIR"),
        ({"HOUSEBOOK_TRUSTED_PROXIES": "proxy.local"}, "not an IP"),
        ({"HOUSEBOOK_WATCH": "fanotify"}, "WATCH"),
    ],
)
def test_settings_errors(env: dict, message: str):
    with pytest.raises(ConfigError, match=message):
        Settings.from_env(env)


def test_process_lock_is_exclusive(tmp_path: Path):
    a, b = ProcessLock(tmp_path), ProcessLock(tmp_path)
    a.acquire()
    with pytest.raises(LockHeld):
        b.acquire()
    a.release()
    b.acquire()
    b.release()
