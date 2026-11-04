"""The "nasty vault" (DESIGN 15.15): every awkward file a real vault eventually contains.

Built programmatically into a temp dir, because NFD names, symlinks, CRLF, BOMs and 0-byte
files don't survive git and editors reliably.
"""

import json
import os
import unicodedata
from pathlib import Path

PDF = b"%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def nfd(s: str) -> str:
    return unicodedata.normalize("NFD", s)


def note(fm: str, body: str = "") -> str:
    return f"---\n{fm.strip()}\n---\n{body}"


def build(root: Path, outside: Path) -> None:
    house = root / "House"
    kitchen = house / "Kitchen"
    kitchen.mkdir(parents=True)
    outside.mkdir(parents=True, exist_ok=True)

    def w(rel: str, content: str | bytes, mtime: int | None = None) -> Path:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            p.write_text(content, encoding="utf-8", newline="")
        else:
            p.write_bytes(content)
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p

    (root / "house.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "grid": {"tileSize": 1, "width": 10, "depth": 6},
                "rooms": [{"id": "rm_k", "name": "Kitchen", "color": "#E3A94B"}],
                "floors": [
                    {
                        "id": "fl_0",
                        "name": "Ground",
                        "level": 0,
                        "cells": {"0,0": "rm_k", "1,0": "rm_k", "2,0": "rm_gone", "12,0": "rm_k", "01,0": "rm_k"},
                    }
                ],
                "placements": [
                    {"itemId": "it_crlf0", "floorId": "fl_0", "x": 0, "y": 0, "rotation": 0},
                    {"itemId": "it_bom000", "floorId": "fl_0", "x": 1, "y": 0, "rotation": 90},
                    {"itemId": "it_ghost1", "floorId": "fl_0", "x": 3, "y": 3, "rotation": 0},
                    {"itemId": "it_crlf0", "floorId": "fl_0", "x": 4, "y": 4, "rotation": 0},
                    {"itemId": "it_dup000", "floorId": "fl_0", "x": 20, "y": 1, "rotation": 0},
                ],
            }
        ),
        encoding="utf-8",
    )

    # Line endings and encodings
    crlf = note(
        "housebook_id: it_crlf0\nname: CRLF note\ntype: fridge\nnext_check: 2026-11-10",
        "\n## Quick help\n- **E15**: crlf code\n",
    )
    w("House/Kitchen/CRLF.md", crlf.replace("\n", "\r\n"))
    w("House/Kitchen/BOM.md", b"\xef\xbb\xbf" + note("housebook_id: it_bom000\nname: BOM note\ntype: oven").encode())
    w("House/Kitchen/Latin1.md", b"---\nname: caf\xe9\n---\n")
    w("House/Kitchen/Plain.md", "Just a note without frontmatter.\n")
    w("House/Kitchen/Empty.md", b"")

    # Broken and half-written
    w("House/Kitchen/Broken.md", "---\nhousebook_id: it_broken\nname: [unclosed\n---\nbody\n")
    w("House/Kitchen/Half.md", "---\nhousebook_id: it_half01\nname: Ha")
    w("House/Kitchen/ListFm.md", "---\n- a\n- b\n---\n")

    # YAML 1.1 traps
    w(
        "House/Kitchen/Serial.md",
        note(
            "housebook_id: it_serial\nname: 0x1F\ntype: washer\nserial: 0123\nmodel: no\nbrand: 1e3\n"
            "purchased: 2024-05-10\ncritical: yes"
        ),
    )

    # Duplicate ids and sync conflict copies
    w("House/Kitchen/Dup A.md", note("housebook_id: it_dup000\nname: Dup A"), mtime=1_700_000_200)
    w("House/Kitchen/Dup B.md", note("housebook_id: it_dup000\nname: Dup B"), mtime=1_700_000_100)
    w("House/Kitchen/Fridge.md", note("housebook_id: it_fridge\nname: Fridge\ntype: fridge"), mtime=1_700_000_500)
    w(
        "House/Kitchen/Fridge.sync-conflict-20260101-120000-ABCDEFG.md",
        note("housebook_id: it_fridge\nname: Fridge (other device)\ntype: fridge"),
        mtime=1_700_000_000,
    )
    w("House/Kitchen/Oven (conflicted copy 2026-01-02).md", note("housebook_id: it_ovenc\nname: Oven copy"))

    # NFD Greek file and folder names; the frontmatter link is NFC
    gr_dir = f"House/{nfd('Κουζίνα')}"
    w(
        f"{gr_dir}/{nfd('Ψυγείο')}.md",
        note('housebook_id: it_greek\nname: Ψυγείο\ntype: fridge\nattachments: ["[[Ψυγείο/εγχειρίδιο.pdf]]"]'),
    )
    w(f"{gr_dir}/{nfd('Ψυγείο')}/{nfd('εγχειρίδιο')}.pdf", PDF)

    # Attachments: listed, sibling folder, missing, escaping, symlinked out, hidden
    w(
        "House/Kitchen/Dishwasher.md",
        note(
            "housebook_id: it_dish00\nname: Dishwasher\ntype: dishwasher\nattachments:\n"
            '  - "[[Dishwasher/manual.pdf|Manual]]"\n  - "[[missing.pdf]]"\n  - "[[../../../outside.pdf]]"'
        ),
    )
    w("House/Kitchen/Dishwasher/manual.pdf", PDF)
    w("House/Kitchen/Dishwasher/photo.png", PNG)
    w("House/Kitchen/Dishwasher/page.html", "<script>alert(1)</script>")
    w("House/Kitchen/Dishwasher/.hidden.pdf", PDF)
    w("House/Kitchen/Dishwasher/notes.md", "not an attachment")
    (outside / "evil.pdf").write_bytes(PDF)
    (outside / "outside.pdf").write_bytes(PDF)
    (kitchen / "Dishwasher" / "evil.pdf").symlink_to(outside / "evil.pdf")

    # Unquoted wikilink: YAML reads [[x]] as a nested list
    w("House/Unquoted.md", note("housebook_id: it_unq000\nname: Unquoted\nattachments: [[Unquoted/file.pdf]]"))
    w("House/Unquoted/file.pdf", PDF)

    # Symlinks escaping the root
    (outside / "secret.md").write_text(note("housebook_id: it_evil00\nname: Secret"), encoding="utf-8")
    (house / "Evil.md").symlink_to(outside / "secret.md")
    (house / "Linked").symlink_to(outside, target_is_directory=True)

    # Every tag form, no id -> not adopted (reported, never written)
    w("House/Tags/Tag1.md", note("tags: housebook\ntype: router"))
    w("House/Tags/Tag2.md", note('tags:\n  - "#housebook"'))
    w("House/Tags/Tag3.md", note("tag: Housebook/appliance"))
    w("House/Tags/Tag4.md", note("tags: [other, housebook]"))
    w("House/Tags/Tag5.md", note('tags: "#housebook, kitchen"'))
    w("House/Tags/NotTagged.md", note("tags: [housebooks, house]"))
    w("House/Tags/Typed.md", note("type: fridge\nname: Typed but untagged"))
    w("House/Tags/TypedUnknown.md", note("type: spaceship"))

    # Field-level problems: item stays indexed
    w("House/Unknown.md", note("housebook_id: it_unkn01\nname: Mystery\ntype: spaceship"))
    w(
        "House/BadDate.md",
        note(
            "housebook_id: it_baddat\nname: Bad dates\nnext_check: soon\nwarranty_until: 2027-13-45\n"
            "check_every: weekly\nmanual: javascript:alert(1)\npurchased: 2024-01-15"
        ),
    )
    w("House/BadId.md", note('housebook_id: "bad id!"\nname: Bad id'))

    # Body with horizontal rules; unknown keys preserved
    w("House/HrBody.md", note("housebook_id: it_hrbody\nname: HR", "\nabove\n\n---\n\nbelow\n---\n"))
    w(
        "House/Extra.md",
        note(
            "housebook_id: it_extra0\nname: Extra\naliases: [Θερμοσίφωνας]\ncssclasses: wide\n"
            "custom:\n  a: 1\n  b: [x, y]"
        ),
    )

    # Ignored: dot dirs/files, editor and sync temp files, notes outside the notes folder
    w("House/.obsidian/workspace.md", note("housebook_id: it_ign001"))
    w("House/.trash/Old.md", note("housebook_id: it_ign002"))
    w("House/~syncthing~Temp.md.tmp", note("housebook_id: it_ign003"))
    w("House/.syncthing.Temp.md.tmp", note("housebook_id: it_ign004"))
    w("House/Kitchen/Fridge.md.swp", "swap")
    w("House/4913", "vim")
    w("Other/Elsewhere.md", note("housebook_id: it_else01\nname: Elsewhere\ntags: housebook"))
    w("Other/Typed.md", note("type: fridge"))
