"""scripts/site.py: the project page's install steps stay those of deploy/compose.yaml."""

import importlib.util
import shutil
from pathlib import Path

import pytest

from conftest import REPO

_spec = importlib.util.spec_from_file_location("site_script", REPO / "scripts" / "site.py")
assert _spec and _spec.loader
site = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(site)


@pytest.fixture
def copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    shutil.copytree(REPO / "site", tmp_path / "site")
    (tmp_path / "deploy").mkdir()
    shutil.copy2(REPO / "deploy" / "compose.yaml", tmp_path / "deploy" / "compose.yaml")
    monkeypatch.setattr(site, "SITE", tmp_path / "site")
    monkeypatch.setattr(site, "COMPOSE", tmp_path / "deploy" / "compose.yaml")
    return tmp_path


def test_the_page_matches_the_install_file():
    assert site.check() == 0
    commands = site.compose_commands()
    assert commands[0] == "mkdir housebook && cd housebook"
    assert commands[-1] == "docker compose up -d"
    assert "mkdir data" in commands  # its trailing comment dropped


def test_a_changed_install_file_fails_the_check(copy: Path, capsys: pytest.CaptureFixture[str]):
    compose = copy / "deploy" / "compose.yaml"
    compose.write_text(compose.read_text().replace("deploy/compose.yaml\n", "deploy/compose.yml\n", 1))
    assert site.check() == 1
    assert "compose.yml" in capsys.readouterr().err


def test_a_changed_page_fails_the_check(copy: Path):
    page = copy / "site" / "index.html"
    page.write_text(page.read_text().replace("docker compose up -d</code>", "docker compose up</code>"))
    assert site.check() == 1


def test_build(tmp_path: Path):
    assert site.build(tmp_path / "out") == 0
    for f in ("index.html", "style.css", "copy.js", "favicon.svg", "screenshots/plan.webp"):
        assert (tmp_path / "out" / f).is_file(), f
