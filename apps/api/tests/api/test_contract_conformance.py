"""Contract conformance from the outside: the committed JSON Schema and the published OpenAPI
response schemas, checked against real files and real responses (tester suite)."""

import copy
import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from fastapi.testclient import TestClient

import nasty_vault

REPO = Path(__file__).resolve().parents[4]
SCHEMA = json.loads((REPO / "contract" / "house.schema.json").read_text(encoding="utf-8"))
EXAMPLE = json.loads((REPO / "examples" / "house" / "house.json").read_text(encoding="utf-8"))
Validator = jsonschema.Draft202012Validator


def schema_errors(doc: Any) -> list[str]:
    return [e.message for e in Validator(SCHEMA).iter_errors(doc)]


def test_schema_is_valid_draft_2020_12():
    Validator.check_schema(SCHEMA)


def test_example_house_validates_against_committed_schema():
    assert schema_errors(EXAMPLE) == []


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d["placements"][0].update(rotation=45), id="rotation-45"),
        pytest.param(lambda d: d["floors"][0]["cells"].update({"01,0": "rm_kit"}), id="padded-cell-key"),
        pytest.param(lambda d: d["floors"][0]["cells"].update({"-1,0": "rm_kit"}), id="negative-cell-key"),
        pytest.param(lambda d: d.update(typo=1), id="unknown-top-level-key"),
        pytest.param(lambda d: d["rooms"][0].update(colour="#000000"), id="unknown-room-key"),
        pytest.param(lambda d: d["rooms"][0].update(color="red"), id="bad-color"),
        pytest.param(lambda d: d.update(schemaVersion=2), id="schema-version-2"),
        pytest.param(lambda d: d.update(floors=[]), id="no-floors"),
        pytest.param(lambda d: d["grid"].update(tileSize=0), id="tile-size-0"),
        pytest.param(lambda d: d["grid"].update(width=513), id="width-513"),
        pytest.param(lambda d: d["openings"][0].update(side="s"), id="opening-side-s"),
        pytest.param(lambda d: d["openings"][0].update(kind="arch"), id="opening-kind"),
        pytest.param(lambda d: d["rooms"][0].update(id="a b"), id="id-with-space"),
        pytest.param(lambda d: d["floors"][0].update(level=201), id="level-201"),
        pytest.param(lambda d: d["placements"][0].update(footprint=[1, 1, 1]), id="footprint-3"),
    ],
)
def test_structurally_invalid_variants_fail_the_schema(mutate):
    doc = copy.deepcopy(EXAMPLE)
    mutate(doc)
    assert schema_errors(doc), "schema accepted an invalid house.json"


@pytest.mark.parametrize("footprint", [[0, 0], [-3, 2]])
def test_non_positive_footprint_is_rejected(footprint):
    doc = copy.deepcopy(EXAMPLE)
    doc["placements"][0]["footprint"] = footprint
    assert schema_errors(doc)


# --- responses vs. the OpenAPI document ------------------------------------------------------


def _response_validator(spec: dict, path: str) -> Validator:
    schema = spec["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    text = json.dumps({**schema, "$defs": spec["components"]["schemas"]})
    return Validator(json.loads(text.replace("#/components/schemas/", "#/$defs/")))


def _check_all(c: TestClient) -> list[str]:
    spec = c.get("/api/openapi.json").json()
    urls = [
        ("/api/house", "/api/house"),
        ("/api/snapshot", "/api/snapshot"),
        ("/api/items", "/api/items"),
        ("/api/items", "/api/items?q=a"),
        ("/api/items", "/api/items?due=3650"),
        ("/api/problems", "/api/problems"),
        ("/api/catalog", "/api/catalog"),
        ("/api/me", "/api/me"),
    ]
    urls += [("/api/items/{item_id}", f"/api/items/{i['id']}") for i in c.get("/api/items").json()["items"]]
    errors = []
    for path, url in urls:
        r = c.get(url)
        assert r.status_code == 200, url
        validator = _response_validator(spec, path)
        errors += [f"{url} {list(e.absolute_path)[:5]}: {e.message[:120]}" for e in validator.iter_errors(r.json())]
    return errors


def test_example_responses_match_openapi(client: TestClient):
    assert _check_all(client) == []


def test_nasty_vault_responses_match_openapi(tmp_path: Path, make_client):
    root = tmp_path / "vault"
    nasty_vault.build(root, tmp_path / "outside")
    # Loose cell keys ("01,0") are canonicalised or dropped on read, so even this vault conforms.
    assert _check_all(make_client(root)) == []
