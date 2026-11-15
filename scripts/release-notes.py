#!/usr/bin/env python3
"""Check that a release tag matches the code, and print its release notes (D50).

    python3 -I scripts/release-notes.py v0.1.0 > notes.md

Fails (exit 1, the reason on stderr) unless:
- the tag is `v<major>.<minor>.<patch>`;
- apps/api/pyproject.toml and apps/web/package.json both have that version;
- CHANGELOG.md has a non-empty `## [<version>] - <YYYY-MM-DD>` section;
- deploy/compose.yaml (the install file people download) uses the image tag `<major>.<minor>`.
Prints that section's body, which becomes the GitHub release's text. Standard library only.
"""

import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAG = re.compile(r"^v(\d+\.\d+\.\d+)$")
IMAGE = re.compile(r"^\s*image:\s*ghcr\.io/[^/\s]+/housebook:(?P<tag>\S+)\s*$", re.MULTILINE)
HEADING = re.compile(r"^## \[(?P<version>[^\]]+)\](?: - (?P<date>\d{4}-\d{2}-\d{2}))?\s*$")


def fail(message: str) -> None:
    print(f"release-notes: {message}", file=sys.stderr)
    sys.exit(1)


def changelog_section(text: str, version: str) -> str | None:
    """The body under `## [version] - date`, up to the next `## ` heading or link list."""
    body: list[str] | None = None
    for line in text.splitlines():
        if body is None:
            m = HEADING.match(line)
            if m and m["version"] == version:
                if not m["date"]:
                    fail(f"CHANGELOG.md: the heading for {version} needs a date: '## [{version}] - YYYY-MM-DD'")
                body = []
            continue
        if line.startswith("## ") or re.match(r"^\[[^\]]+\]: ", line):
            break
        body.append(line)
    return None if body is None else "\n".join(body).strip()


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        fail("usage: release-notes.py v<major>.<minor>.<patch>")
    m = TAG.match(argv[1])
    if not m:
        fail(f"'{argv[1]}' is not a release tag (v<major>.<minor>.<patch>, e.g. v0.1.0)")
    version = m[1]

    api = tomllib.loads((REPO / "apps/api/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    web = json.loads((REPO / "apps/web/package.json").read_text(encoding="utf-8"))["version"]
    wrong = [f"{name} has {v}" for name, v in (("apps/api/pyproject.toml", api), ("apps/web/package.json", web)) if v != version]
    if wrong:
        fail(f"the tag says {version} but " + " and ".join(wrong) + " (see docs/releasing.md)")

    minor = version.rsplit(".", 1)[0]
    tags = IMAGE.findall((REPO / "deploy/compose.yaml").read_text(encoding="utf-8"))
    if tags != [minor]:
        found = ", ".join(tags) or "no ghcr.io image line"
        fail(f"deploy/compose.yaml should use the image tag {minor} (found {found})")

    notes = changelog_section((REPO / "CHANGELOG.md").read_text(encoding="utf-8"), version)
    if notes is None:
        fail(f"CHANGELOG.md has no '## [{version}] - YYYY-MM-DD' section")
    if not notes:
        fail(f"CHANGELOG.md: the section for {version} is empty")
    print(notes)


if __name__ == "__main__":
    main(sys.argv)
