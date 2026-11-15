"""scripts/release-notes.py: the release workflow's check of tag, versions and changelog (D50)."""

import importlib.util
import subprocess
import sys

import pytest

from conftest import REPO

SCRIPT = REPO / "scripts" / "release-notes.py"
_spec = importlib.util.spec_from_file_location("release_notes", SCRIPT)
assert _spec and _spec.loader
release_notes = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release_notes)

CHANGELOG = """# Changelog

## [Unreleased]

- Next thing.

## [0.2.0] - 2027-01-10

### Added

- Furniture.

## [0.1.0] - 2026-12-01

- First release.

[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
"""


def test_section_is_the_text_up_to_the_next_heading():
    assert release_notes.changelog_section(CHANGELOG, "0.2.0") == "### Added\n\n- Furniture."
    assert release_notes.changelog_section(CHANGELOG, "0.1.0") == "- First release."
    assert release_notes.changelog_section(CHANGELOG, "0.3.0") is None


def test_a_section_needs_a_date():
    with pytest.raises(SystemExit):
        release_notes.changelog_section("## [0.1.0]\n\n- x\n", "0.1.0")


def _run(tag: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-I", str(SCRIPT), tag], capture_output=True, text=True, check=False)


@pytest.mark.parametrize("tag", ["0.1.0", "v1.0", "v1.0.0-rc.1", "v01.2.3x"])
def test_only_plain_version_tags(tag: str):
    r = _run(tag)
    assert r.returncode == 1 and "is not a release tag" in r.stderr


def test_the_tag_must_match_both_versions():
    r = _run("v99.0.0")
    assert r.returncode == 1
    assert "apps/api/pyproject.toml has" in r.stderr and "apps/web/package.json has" in r.stderr


def test_the_install_file_uses_the_minor_version_tag():
    text = (REPO / "deploy" / "compose.yaml").read_text(encoding="utf-8")
    assert release_notes.IMAGE.findall(text) == ["0.1"]
    assert release_notes.IMAGE.findall("    image: ghcr.io/someone/housebook:0.2\n") == ["0.2"]
    assert release_notes.IMAGE.findall("    # image: ghcr.io/someone/housebook:0.2\n") == []
