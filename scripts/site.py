#!/usr/bin/env python3
"""The project page (site/, published on GitHub Pages by .github/workflows/pages.yml).

  python3 -I scripts/site.py check          the install steps on the page match deploy/compose.yaml
  python3 -I scripts/site.py build [OUT]    site/ plus the screenshots and the icon, in OUT (_site)

Standard library only. The page repeats the install commands from the comment at the top of
deploy/compose.yaml; `check` fails when they differ, so the two can't drift apart.
"""

import html
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SITE = REPO / "site"
COMPOSE = REPO / "deploy" / "compose.yaml"


def compose_commands() -> list[str]:
    """The first block of indented commands in the comment at the top of the install file,
    without their trailing comments."""
    commands: list[str] = []
    for line in COMPOSE.read_text(encoding="utf-8").splitlines():
        m = re.fullmatch(r"#   (\S.*)", line)
        if m:
            commands.append(re.sub(r"\s+#\s.*$", "", m[1]).rstrip())
        elif commands or not line.startswith("#"):
            break
    return commands


def page_commands() -> list[str]:
    """The lines of every `<code class="install">` block on the page, in order."""
    page = (SITE / "index.html").read_text(encoding="utf-8")
    blocks = re.findall(r'<code class="install">(.*?)</code>', page, flags=re.S)
    return [html.unescape(line).rstrip() for block in blocks for line in block.splitlines() if line.strip()]


def check() -> int:
    want, got = compose_commands(), page_commands()
    if not want:
        print(f"no commands found at the top of {COMPOSE.relative_to(REPO)}", file=sys.stderr)
        return 1
    if want != got:
        print("site/index.html's install steps differ from deploy/compose.yaml:", file=sys.stderr)
        for w, g in zip(want + [""] * len(got), got + [""] * len(want), strict=False):
            if w != g:
                print(f"  compose.yaml: {w!r}\n  index.html:   {g!r}", file=sys.stderr)
        return 1
    print(f"install steps match deploy/compose.yaml ({len(want)} commands)")
    return 0


def build(out: Path) -> int:
    if check():
        return 1
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SITE, out)
    shutil.copytree(REPO / "docs" / "screenshots", out / "screenshots")
    shutil.copy2(REPO / "apps" / "web" / "public" / "favicon.svg", out / "favicon.svg")
    page = (out / "index.html").read_text(encoding="utf-8")
    for ref in re.findall(r'(?:src|href)="((?!https?:|#|\./)[^"]+)"', page):
        if not (out / ref).is_file():
            print(f"index.html links to {ref}, which isn't in the build", file=sys.stderr)
            return 1
    print(f"built {out}")
    return 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["check"]:
        return check()
    if argv[:1] == ["build"]:
        return build(Path(argv[1]) if len(argv) > 1 else REPO / "_site")
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
