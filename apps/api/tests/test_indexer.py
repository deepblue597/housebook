import os
from pathlib import Path

import pytest

import nasty_vault
from housebook.adapters.fs import FsHouseRepo, MarkdownNoteRepo
from housebook.domain.catalog import Catalog
from housebook.domain.problems import Problem
from housebook.services.indexer import Indexer, IndexState


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    nasty_vault.build(root, tmp_path / "outside")
    return root


def make_indexer(root: Path, catalog: Catalog) -> Indexer:
    return Indexer(FsHouseRepo(root), MarkdownNoteRepo(root, "House"), catalog)


@pytest.fixture
def state(vault: Path, catalog: Catalog) -> IndexState:
    return make_indexer(vault, catalog).scan()


def by_kind(state: IndexState) -> dict[str, list[Problem]]:
    out: dict[str, list[Problem]] = {}
    for p in state.problems:
        out.setdefault(p.kind.value, []).append(p)
    return out


def paths(problems: list[Problem]) -> set[str]:
    return {p.path or "" for p in problems}


def test_indexed_items(state: IndexState):
    assert set(state.items) == {
        "it_crlf0",
        "it_bom000",
        "it_serial",
        "it_dup000",
        "it_fridge",
        "it_ovenc",
        "it_greek",
        "it_dish00",
        "it_unq000",
        "it_unkn01",
        "it_baddat",
        "it_hrbody",
        "it_extra0",
    }


def test_crlf_bom_and_yaml_traps(state: IndexState):
    crlf = state.items["it_crlf0"]
    assert crlf.fields.name == "CRLF note" and crlf.error_codes == ("E15",)
    assert "\r" not in crlf.body
    assert state.items["it_bom000"].fields.name == "BOM note"
    serial = state.items["it_serial"].fields
    assert (serial.serial, serial.model, serial.brand, serial.name) == ("0123", "no", "1e3", "0x1F")
    assert serial.critical is True


def test_unknown_keys_and_body_preserved(state: IndexState):
    extra = state.items["it_extra0"].raw
    assert extra["aliases"] == ["Θερμοσίφωνας"] and extra["custom"] == {"a": "1", "b": ["x", "y"]}
    assert state.items["it_hrbody"].body == "\nabove\n\n---\n\nbelow\n---\n"


def test_duplicates_and_conflict_copies(state: IndexState):
    kinds = by_kind(state)
    # Oldest mtime wins on the first scan.
    assert state.items["it_dup000"].rel == "House/Kitchen/Dup B.md"
    assert paths(kinds["duplicate_id"]) == {"House/Kitchen/Dup A.md"}
    # A non-conflict file wins over an older conflict copy.
    assert state.items["it_fridge"].rel == "House/Kitchen/Fridge.md"
    assert paths(kinds["conflict_copy"]) == {
        "House/Kitchen/Fridge.sync-conflict-20260101-120000-ABCDEFG.md",
        "House/Kitchen/Oven (conflicted copy 2026-01-02).md",
    }
    assert state.items["it_ovenc"].conflict_copy


def test_canonical_path_is_sticky(vault: Path, catalog: Catalog):
    ix = make_indexer(vault, catalog)
    assert ix.scan().items["it_dup000"].rel == "House/Kitchen/Dup B.md"
    os.utime(vault / "House/Kitchen/Dup B.md", (1_800_000_000, 1_800_000_000))  # now the newest
    assert ix.scan().items["it_dup000"].rel == "House/Kitchen/Dup B.md"  # already indexed: stays
    assert make_indexer(vault, catalog).scan().items["it_dup000"].rel == "House/Kitchen/Dup A.md"


def test_parse_errors(state: IndexState):
    errors = {p.path: p.message for p in by_kind(state)["note_parse_error"]}
    assert set(errors) == {
        "House/Kitchen/Broken.md",
        "House/Kitchen/Half.md",
        "House/Kitchen/ListFm.md",
        "House/Kitchen/Latin1.md",
    }
    assert "not closed" in errors["House/Kitchen/Half.md"]


def test_parse_failure_keeps_last_good(vault: Path, catalog: Catalog):
    ix = make_indexer(vault, catalog)
    ix.scan()
    note = vault / "House/Kitchen/CRLF.md"
    good = note.read_bytes()

    note.write_text("---\nhousebook_id: it_crlf0\nname: CRLF no", encoding="utf-8")  # half-written
    s = ix.scan()
    item = s.items["it_crlf0"]
    assert item.stale and "not closed" in (item.parse_error or "") and item.fields.name == "CRLF note"
    assert any(p.path == "House/Kitchen/CRLF.md" and p.item_id == "it_crlf0" for p in s.problems)

    note.write_bytes(b"")  # truncated mid-save
    assert ix.scan().items["it_crlf0"].stale

    note.write_bytes(good)
    item = ix.scan().items["it_crlf0"]
    assert not item.stale and item.parse_error is None


def test_house_parse_failure_keeps_last_good(vault: Path, catalog: Catalog):
    ix = make_indexer(vault, catalog)
    first = ix.scan().house
    (vault / "house.json").write_text('{"schemaVersion": 1, "grid": ', encoding="utf-8")
    s = ix.scan()
    assert s.house.stale and s.house.house == first.house
    assert any(p.kind == "house_invalid" and "last valid" in p.message for p in s.problems)


def test_new_unparseable_note_is_not_an_item(state: IndexState):
    assert "it_broken" not in state.items and "it_half01" not in state.items


def test_nfd_greek_names_and_attachment(state: IndexState):
    greek = state.items["it_greek"]
    assert greek.fields.name == "Ψυγείο"
    assert [a.name for a in greek.attachments] == ["εγχειρίδιο.pdf"]  # NFC name, NFD on disk


def test_attachments(state: IndexState):
    dish = state.items["it_dish00"]
    assert {a.name: a.listed for a in dish.attachments} == {
        "manual.pdf": True,
        "page.html": False,
        "photo.png": False,
    }
    kinds = by_kind(state)
    assert any("missing.pdf" in p.message for p in kinds["attachment_missing"])
    assert any("outside.pdf" in p.message for p in kinds["attachment_unsafe"])
    assert [a.name for a in state.items["it_unq000"].attachments] == ["file.pdf"]


def test_symlinks_out_of_root(state: IndexState):
    assert "it_evil00" not in state.items
    assert paths(by_kind(state)["symlink_outside_root"]) == {
        "House/Evil.md",
        "House/Linked",
        "House/Kitchen/Dishwasher/evil.pdf",
    }


def test_adoption_is_reported_not_written(vault: Path, state: IndexState):
    kinds = by_kind(state)
    assert paths(kinds["not_adopted"]) == {f"House/Tags/Tag{i}.md" for i in range(1, 6)}
    assert paths(kinds["untagged_typed"]) == {"House/Tags/Typed.md"}
    assert "housebook_id" not in (vault / "House/Tags/Tag1.md").read_text(encoding="utf-8")


def test_field_problems_keep_the_item(state: IndexState):
    bad = state.items["it_baddat"]
    assert bad.fields.next_check is None and bad.fields.manual is None
    assert bad.fields.purchased is not None
    keys = {p.detail["key"] for p in by_kind(state)["note_invalid_field"] if p.item_id == "it_baddat"}
    assert keys == {"next_check", "warranty_until", "check_every", "manual"}
    assert paths(by_kind(state)["note_invalid_id"]) == {"House/BadId.md"}
    assert paths(by_kind(state)["unknown_type"]) == {"House/Unknown.md"}


def test_house_problems_and_cross_file(state: IndexState):
    kinds = by_kind(state)
    assert {p.item_id for p in kinds["missing_note"]} == {"it_ghost1"}
    assert len(kinds["house_duplicate_placement"]) == 1
    assert len(kinds["house_unknown_room"]) == 1
    assert len(kinds["house_bad_cell"]) == 1
    assert len(kinds["house_outside_grid"]) == 2  # cell 12,0 and placement at 20,1
    assert state.items["it_bom000"].location.room_id == "rm_k"


def test_ignored_files_and_notes_outside_notes_folder(state: IndexState):
    all_paths = {p.path for p in state.problems} | {i.rel for i in state.items.values()}
    for ignored in ("it_ign001", "it_ign002", "it_ign003", "it_ign004", "it_else01"):
        assert ignored not in state.items
    assert not any(p and (p.startswith("Other/") or "/." in p or p.endswith(("4913", ".swp"))) for p in all_paths)
    assert not any(p.path in ("House/Kitchen/Empty.md", "House/Kitchen/Plain.md") for p in state.problems)


def test_example_house_has_no_problems(example_root: Path, catalog: Catalog):
    s = make_indexer(example_root, catalog).scan()
    assert s.problems == ()
    assert len(s.items) == 14
    assert all(i.location is not None for i in s.items.values())
