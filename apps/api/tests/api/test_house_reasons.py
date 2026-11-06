"""M2-07: every house_invalid / house_newer_version problem carries `detail.reason`, a closed
enum, so clients never have to classify the failure by matching message text (data contract §7).
"""

import json
import os
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import vault_builders as vb
from housebook.domain.problems import HouseProblemReason
from housebook.migrations.house import MigrationError
from housebook.services import indexer as indexer_mod

HOUSE_KINDS = {"house_invalid", "house_newer_version"}
REASONS = {r.value for r in HouseProblemReason}


@pytest.fixture
def root(tmp_path: Path) -> Path:
    return tmp_path / "data"


def house_problems(c: TestClient) -> list[dict]:
    return [p for p in c.get("/api/problems").json()["problems"] if p["kind"] in HOUSE_KINDS]


def only_reason(c: TestClient) -> str:
    [p] = house_problems(c)
    assert p["kind"] == "house_invalid" and "read-only" in p["message"]
    assert set(p["detail"]) == {"reason"}
    return p["detail"]["reason"]


def test_reason_enum_is_the_documented_closed_set():
    doc = (Path(__file__).resolve().parents[4] / "docs" / "data-contract.md").read_text(encoding="utf-8")
    section = doc.split("### 7.1 ", 1)[1].split("\n#", 1)[0]
    documented = set(re.findall(r"^\| `([a-z_]+)` \|", section, flags=re.M))
    assert documented - {"reason"} == REASONS  # minus the header cell
    assert {"unreadable", "too_large", "not_json", "bad_version", "newer_version", "invalid"} == REASONS


# --- unreadable ------------------------------------------------------------------------------------


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores file permissions")
def test_permission_denied_is_unreadable(root: Path, make_client):
    vb.write_house(root, vb.house())
    path = root / "house.json"
    path.chmod(0)
    try:
        assert only_reason(make_client(root)) == "unreadable"
    finally:
        path.chmod(0o644)


def test_directory_named_house_json_is_unreadable(root: Path, make_client):
    (root / "house.json").mkdir(parents=True)
    assert only_reason(make_client(root)) == "unreadable"


def test_symlink_outside_root_is_unreadable(tmp_path: Path, root: Path, make_client):
    root.mkdir()
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps(vb.house()), encoding="utf-8")
    (root / "house.json").symlink_to(outside)
    assert only_reason(make_client(root)) == "unreadable"


# --- too_large -------------------------------------------------------------------------------------


def test_too_large_is_its_own_reason(root: Path, make_client, monkeypatch):
    """M2-08: an oversized file is not a permissions problem; the message stays unchanged."""
    monkeypatch.setattr(indexer_mod, "MAX_HOUSE_BYTES", 64)
    vb.write_house(root, vb.house())
    c = make_client(root)
    assert only_reason(c) == "too_large"
    [p] = house_problems(c)
    assert p["message"].startswith("house.json is invalid: file is larger than 0 MiB")


def test_real_limit_message_names_16_mib(root: Path, make_client):
    vb.write_house(root, vb.house(name="x" * (16 * 1024 * 1024)))
    [p] = house_problems(make_client(root))
    assert p["detail"] == {"reason": "too_large"}
    assert p["message"].startswith("house.json is invalid: file is larger than 16 MiB")


# --- not_json --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "content",
    [
        pytest.param('{"schemaVersion": 1, "grid": ', id="truncated"),
        pytest.param("", id="empty"),
        pytest.param("not json", id="text"),
        pytest.param(b'{"schemaVersion": 1, "name": "\xff\xfe"}', id="bad-utf8"),
        pytest.param("[" * 100_000 + "]" * 100_000, id="nested-too-deep"),
    ],
)
def test_unparseable_is_not_json(root: Path, make_client, content: str | bytes):
    vb.write(root, "house.json", content)
    assert only_reason(make_client(root)) == "not_json"


# --- bad_version -----------------------------------------------------------------------------------


@pytest.mark.parametrize("version", ["1", "2", 2.5, 1.0, True, 0, -1, None, "missing"])
def test_bad_schema_version(root: Path, make_client, version):
    data = vb.house(schemaVersion=version)
    if version == "missing":
        del data["schemaVersion"]
    vb.write_house(root, data)
    assert only_reason(make_client(root)) == "bad_version"


@pytest.mark.parametrize("content", ["[]", "42", '"house"', "null"])
def test_non_object_root_is_bad_version(root: Path, make_client, content: str):
    """Valid JSON that isn't an object has no schemaVersion (the message says "got missing")."""
    vb.write_house(root, content)
    assert only_reason(make_client(root)) == "bad_version"


def test_older_version_without_migration_is_bad_version(root: Path, make_client, monkeypatch):
    def no_path(data):
        raise MigrationError("no migration from schemaVersion 1 to 2")

    monkeypatch.setattr(indexer_mod, "migrate", no_path)
    vb.write_house(root, vb.house())
    assert only_reason(make_client(root)) == "bad_version"


# --- newer_version ---------------------------------------------------------------------------------


def test_newer_version_displayable(root: Path, make_client):
    vb.write_house(root, vb.house(schemaVersion=2))
    [p] = house_problems(make_client(root))
    assert p["kind"] == "house_newer_version" and p["detail"] == {"reason": "newer_version"}


def test_newer_version_not_displayable_both_problems_say_newer(root: Path, make_client):
    """The layout can't be shown because this image is too old, not because the file is broken."""
    vb.write_house(root, vb.house(schemaVersion=3, grid="huge"))
    ps = house_problems(make_client(root))
    assert sorted(p["kind"] for p in ps) == ["house_invalid", "house_newer_version"]
    assert all(p["detail"] == {"reason": "newer_version"} for p in ps)


# --- invalid ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d.update(unreadableNote="x"), id="unknown-key-unreadableNote"),
        pytest.param(lambda d: d["rooms"][0].update(schemaVersion=2), id="nested-key-schemaVersion"),
        pytest.param(lambda d: d["grid"].update(width="wide"), id="grid-width-string"),
        pytest.param(lambda d: d.update(floors=[]), id="no-floors"),
        pytest.param(lambda d: d.update(typo=1), id="unknown-key"),
    ],
)
def test_structural_failure_is_invalid(root: Path, make_client, mutate):
    data = vb.house()
    mutate(data)
    vb.write_house(root, data)
    assert only_reason(make_client(root)) == "invalid"


def test_unreadable_note_key_message_would_fool_text_matching(root: Path, make_client):
    """The regression behind M2-07: the user's key name lands in the message, so the text
    looks like "can't be read"; the reason stays `invalid`."""
    vb.write_house(root, vb.house(unreadableNote="x"))
    [p] = house_problems(make_client(root))
    assert "unreadableNote" in p["message"]
    assert p["detail"] == {"reason": "invalid"}


# --- last valid kept; other kinds untouched --------------------------------------------------------


@pytest.mark.parametrize(
    "broken, reason",
    [
        ('{"schemaVersion": 1, "grid": ', "not_json"),
        (json.dumps(vb.house(schemaVersion="1")), "bad_version"),
        (json.dumps(vb.house(typo=1)), "invalid"),
    ],
)
def test_reason_when_last_valid_is_kept(root: Path, make_client, broken: str, reason: str):
    vb.write_house(root, vb.house())
    c = make_client(root)
    vb.write_house(root, broken)
    c.app.state.ctx.indexer.scan()
    [p] = house_problems(c)
    assert "last valid" in p["message"] and p["detail"] == {"reason": reason}
    assert c.get("/api/house").status_code == 200


def test_valid_house_has_no_reason_and_other_details_unchanged(root: Path, make_client):
    vb.write_house(root, vb.house())
    vb.item(root, "it_bad", "name: Bad\nnext_check: soon")
    ps = make_client(root).get("/api/problems").json()["problems"]
    assert not [p for p in ps if p["kind"] in HOUSE_KINDS]
    assert [p["detail"] for p in ps if p["kind"] == "note_invalid_field"] == [{"key": "next_check"}]


def test_openapi_describes_reason_enum(client: TestClient):
    schemas = client.get("/api/openapi.json").json()["components"]["schemas"]
    detail = schemas["Problem"]["properties"]["detail"]
    assert {"$ref": "#/components/schemas/ProblemDetail"} in detail["anyOf"]
    pd = schemas["ProblemDetail"]
    assert pd["type"] == "object" and pd["additionalProperties"] == {"type": "string"}
    assert pd["properties"]["reason"] == {"$ref": "#/components/schemas/HouseProblemReason"}
    assert set(schemas["HouseProblemReason"]["enum"]) == REASONS
