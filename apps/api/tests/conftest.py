import json
import shutil
from collections.abc import Callable, Iterator
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from housebook.api.app import create_app
from housebook.config import Settings
from housebook.domain.catalog import Catalog, load_catalog

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "contract"
EXAMPLES = REPO / "examples" / "house"

# Fixed "now": 2026-11-04 12:00 in Athens.
NOW = datetime(2026, 11, 4, 10, 0, tzinfo=UTC)


def load_fixture(name: str) -> dict:
    return json.loads((CONTRACT / "fixtures" / name).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def catalog() -> Catalog:
    return load_catalog(CONTRACT / "catalog.json")


@pytest.fixture
def example_root(tmp_path: Path) -> Path:
    """A private copy of examples/house (the app writes .housebook/lock into its root)."""
    root = tmp_path / "data"
    shutil.copytree(EXAMPLES, root, ignore=shutil.ignore_patterns(".housebook"))
    return root


def make_settings(root: Path, **overrides: object) -> Settings:
    # The watcher is off unless a test opts in (tests/test_watcher.py): API writes rescan by
    # themselves, and an inotify thread per client would only slow the suite down.
    base = Settings(data_dir=root, tz="Europe/Athens", contract_dir=CONTRACT, rescan_interval=0, watch="off")
    return replace(base, **overrides)


ClientFactory = Callable[..., TestClient]


@pytest.fixture
def make_client() -> Iterator[ClientFactory]:
    clients: list[TestClient] = []

    def factory(root: Path, client_host: str = "testclient", **overrides: object) -> TestClient:
        app = create_app(make_settings(root, **overrides), clock=lambda: NOW)
        client = TestClient(app, client=(client_host, 50000))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root)
