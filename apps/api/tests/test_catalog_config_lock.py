import ipaddress
from pathlib import Path

import pytest

from housebook.config import ConfigError, Settings
from housebook.domain.catalog import Catalog
from housebook.lock import LockHeld, ProcessLock, network_fs_type

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
        (
            {"HOUSEBOOK_AUTH_MODE": "oidc"},
            "needs HOUSEBOOK_PUBLIC_URL, HOUSEBOOK_OIDC_ISSUER, HOUSEBOOK_OIDC_CLIENT_ID",
        ),
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


def test_poll_interval_env():
    assert Settings.from_env({"HOUSEBOOK_POLL_INTERVAL": "2.5"}).poll_interval == 2.5
    assert Settings.from_env({}).poll_interval == 5.0
    for bad in ("0", "abc", "99999"):
        with pytest.raises(ConfigError):
            Settings.from_env({"HOUSEBOOK_POLL_INTERVAL": bad})


def test_network_fs_detection(tmp_path: Path):
    mounts = tmp_path / "mounts"
    mounts.write_text(
        "/dev/sda1 / ext4 rw 0 0\n"
        "nas:/vol /mnt/nas nfs4 rw 0 0\n"
        "//srv/share /mnt/my\\040share cifs rw 0 0\n"
        "/dev/sdb1 /mnt/nas/local ext4 rw 0 0\n"
    )
    assert network_fs_type(Path("/mnt/nas/vault"), str(mounts)) == "nfs4"
    assert network_fs_type(Path("/mnt/my share/x"), str(mounts)) == "cifs"
    assert network_fs_type(Path("/mnt/nas/local/x"), str(mounts)) is None  # most specific mount wins
    assert network_fs_type(Path("/home"), str(mounts)) is None
    assert network_fs_type(Path("/x"), str(tmp_path / "missing")) is None
