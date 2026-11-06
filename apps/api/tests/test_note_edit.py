"""Minimal-diff note edits (DESIGN 15.4, 15.6, D12): pure functions, no files."""

from datetime import date

import pytest

from conftest import load_fixture
from housebook.domain.frontmatter import parse
from housebook.domain.note_edit import (
    NoteEditError,
    append_log,
    build_note,
    edit_note,
    insert_first_key,
    merge_patch,
    render_entry,
)
from housebook.domain.paths import clean_filename, unique_stem

NOTE = b"""---
housebook_id: it_a  # assigned by the app
# brand and model from the sticker
brand: Bosch
model: SMS4HVI33E
serial: '0123'
tags:
  - housebook
  - kitchen
aliases: [Dishwasher]
cssclasses: wide
custom:
  a: 1
  b: [x, y]
---

## Quick help
- **E15**: water in the base

## Maintenance log
- 2026-09-15 Technician replaced the drain pump (85 \xe2\x82\xac)

## Notes
Uses 3-in-1 tabs.
"""


def lines(raw: bytes) -> list[str]:
    return raw.decode().split("\n")


def changed_lines(before: bytes, after: bytes) -> tuple[list[str], list[str]]:
    a, b = lines(before), lines(after)
    return [x for x in a if x not in b], [x for x in b if x not in a]


# --- merge patch ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("target", "patch", "expected"),
    [  # RFC 7396 appendix A, plus the shapes frontmatter uses
        ({"a": "b"}, {"a": "c"}, {"a": "c"}),
        ({"a": "b"}, {"b": "c"}, {"a": "b", "b": "c"}),
        ({"a": "b"}, {"a": None}, {}),
        ({"a": "b", "b": "c"}, {"a": None}, {"b": "c"}),
        ({"a": ["b"]}, {"a": "c"}, {"a": "c"}),
        ({"a": "c"}, {"a": ["b"]}, {"a": ["b"]}),
        ({"a": {"b": "c"}}, {"a": {"b": "d", "c": None}}, {"a": {"b": "d"}}),
        ({"a": [{"b": "c"}]}, {"a": [1]}, {"a": [1]}),
        ({"e": None}, {"a": 1}, {"e": None, "a": 1}),
        ({}, {"a": {"bb": {"ccc": None}}}, {"a": {"bb": {}}}),
    ],
)
def test_merge_patch_rfc7396(target, patch, expected):
    assert merge_patch(target, patch) == expected


# --- minimal diff ----------------------------------------------------------------------------------


def test_changing_one_key_touches_one_line():
    out = edit_note(NOTE, {"brand": "Siemens"}, None).raw
    assert changed_lines(NOTE, out) == (["brand: Bosch"], ["brand: Siemens"])
    assert out.replace(b"brand: Siemens", b"brand: Bosch") == NOTE  # everything else byte-identical


def test_comments_key_order_and_unknown_keys_survive():
    out = edit_note(NOTE, {"model": "X1", "next_check": "2027-03-01"}, None).raw
    text = out.decode()
    assert "housebook_id: it_a  # assigned by the app" in text
    assert "# brand and model from the sticker" in text
    assert "custom:\n  a: 1\n  b: [x, y]" in text and "cssclasses: wide" in text
    fm = lines(out)[1 : lines(out).index("---", 1)]
    keys = [ln.split(":")[0] for ln in fm if ln and ln[0].isalpha()]
    assert keys == ["housebook_id", "brand", "model", "serial", "tags", "aliases", "cssclasses", "custom", "next_check"]
    assert parse(out).body == parse(NOTE).body


def test_null_deletes_the_whole_block_and_keeps_neighbours():
    out = edit_note(NOTE, {"tags": None, "custom": None}, None).raw
    assert b"tags:" not in out and b"  - kitchen" not in out and b"custom:" not in out and b"  a: 1" not in out
    assert b"aliases: [Dishwasher]\ncssclasses: wide\n---" in out
    assert "tags" not in parse(out).data


def test_nested_merge_patch_rewrites_only_that_key():
    out = edit_note(NOTE, {"custom": {"a": None, "c": "z"}}, None)
    assert out.data["custom"] == {"b": ["x", "y"], "c": "z"}
    assert changed_lines(NOTE, out.raw)[1] == ['custom: {b: [x, "y"], c: z}']  # `y` is a YAML 1.1 bool


def test_inline_comment_and_quote_style_are_kept():
    out = edit_note(NOTE, {"housebook_id": "it_a", "serial": "0456"}, None).raw
    assert b"serial: '0456'" in out  # user's single quotes kept; still quoted (leading zero)
    out = edit_note(b"---\nbrand: Bosch  # sticker\n---\n", {"brand": "Miele"}, None).raw
    assert out == b"---\nbrand: Miele  # sticker\n---\n"


def test_block_list_style_is_kept():
    out = edit_note(NOTE, {"tags": ["housebook", "kitchen", "#2 floor"]}, None).raw
    assert b'tags:\n  - housebook\n  - kitchen\n  - "#2 floor"\n' in out
    out = edit_note(b"---\ntags:\n- a\n---\n", {"tags": ["a", "b"]}, None).raw
    assert out == b"---\ntags:\n- a\n- b\n---\n"


def test_flow_list_and_new_keys_are_appended_before_the_closing_line():
    out = edit_note(b"---\na: x\n\n---\nbody\n", {"attachments": ["[[Dishwasher/manual.pdf]]"]}, None).raw
    assert out == b'---\na: x\nattachments: ["[[Dishwasher/manual.pdf]]"]\n\n---\nbody\n'


def test_crlf_and_bom_are_preserved():
    raw = b"\xef\xbb\xbf---\r\nname: A\r\nbrand: B\r\n---\r\nline 1\r\nline 2\r\n"
    out = edit_note(raw, {"brand": "C"}, None).raw
    assert out == b"\xef\xbb\xbf---\r\nname: A\r\nbrand: C\r\n---\r\nline 1\r\nline 2\r\n"
    out = edit_note(raw, None, "new\nbody\n").raw
    assert out.endswith(b"---\r\nnew\r\nbody\r\n")


def test_unchanged_patch_is_a_no_op():
    assert edit_note(NOTE, {"brand": "Bosch", "serial": "0123"}, None).raw == NOTE
    assert edit_note(NOTE, {"missing": None}, None).raw == NOTE


def test_body_replaced_verbatim_and_frontmatter_untouched():
    out = edit_note(NOTE, None, "\n## Notes\n---\nnot frontmatter\n").raw
    fm_end = NOTE.index(b"\n---\n", 4) + 5
    assert out[:fm_end] == NOTE[:fm_end]
    assert parse(out).body == "\n## Notes\n---\nnot frontmatter\n"


def test_duplicate_keys_collapse_into_the_first():
    out = edit_note(b"---\nname: a\nbrand: x\nname: b\n---\n", {"name": "c"}, None).raw
    assert out == b"---\nname: c\nbrand: x\n---\n"


def test_flow_mapping_frontmatter_falls_back_to_a_full_render():
    out = edit_note(b"---\n{name: a, serial: 0123}\n---\n", {"name": "b"}, None).raw
    assert out == b'---\nname: b\nserial: "0123"\n---\n'


def test_multiline_and_block_scalars():
    raw = b"---\nnotes: |\n  line one\n  line two\nbrand: B\n---\n"
    out = edit_note(raw, {"notes": "first\nsecond"}, None)
    assert out.raw == b'---\nnotes: "first\\nsecond"\nbrand: B\n---\n'
    assert out.data["notes"] == "first\nsecond"


# --- YAML 1.1 traps: strings stay strings for every reader -------------------------------------------


@pytest.mark.parametrize("case", load_fixture("frontmatter_write_cases.json")["cases"], ids=lambda c: c["id"])
def test_scalar_rendering(case):
    line = render_entry(case["key"], case["value"])
    assert line == [case["line"]]
    raw = build_note({case["key"]: case["value"]}, "")
    assert parse(raw).data[case["key"]] == (case["value"] if isinstance(case["value"], str) else case["readsAs"])


def test_quoted_values_read_back_identically_with_pyyaml_safe_loader():
    """The point of quoting: tools using YAML 1.1 resolvers (PyYAML SafeLoader) see strings."""
    import yaml

    values = {"serial": "0123", "model": "no", "brand": "1e3", "name": "0x1F", "a": "on", "b": "~", "c": "1:30"}
    raw = build_note(values, "").decode()
    fm = raw.split("---\n")[1]
    assert yaml.safe_load(fm) == values


def test_unwritable_values_are_refused():
    with pytest.raises(NoteEditError):
        edit_note(b"---\na: x\n---\n", {"tags": [None]}, None)


# --- adoption, creation ---------------------------------------------------------------------------


def test_insert_first_key():
    raw = b"---\r\ntags: housebook  # mine\r\ntype: router\r\n---\r\nbody\r\n"
    assert insert_first_key(raw, "housebook_id", "it_abc123") == (
        b"---\r\nhousebook_id: it_abc123\r\ntags: housebook  # mine\r\ntype: router\r\n---\r\nbody\r\n"
    )
    with pytest.raises(NoteEditError):
        insert_first_key(b"---\nhousebook_id: x\n---\n", "housebook_id", "y")


def test_build_note():
    raw = build_note({"housebook_id": "it_x", "type": "fridge", "name": "Ψυγείο: big", "tags": ["housebook"]}, "\nB\n")
    assert raw.decode() == '---\nhousebook_id: it_x\ntype: fridge\nname: "Ψυγείο: big"\ntags: [housebook]\n---\n\nB\n'


# --- maintenance log -------------------------------------------------------------------------------

D = date(2026, 11, 6)


def test_log_appends_after_the_last_entry_of_the_section():
    body = "\n## Quick help\n- x\n\n## Maintenance log\n- 2026-01-01 a\n- 2026-02-01 b\n\n## Notes\nn\n"
    assert append_log(body, D, "Descaled") == (
        "\n## Quick help\n- x\n\n## Maintenance log\n- 2026-01-01 a\n- 2026-02-01 b\n- 2026-11-06 Descaled\n\n"
        "## Notes\nn\n"
    )


def test_log_section_any_level_case_insensitive_subheadings_included():
    body = "# Log\n### maintenance LOG\n- 2026-01-01 a\n#### detail\ntext\n## Next\n"
    expected = "# Log\n### maintenance LOG\n- 2026-01-01 a\n#### detail\ntext\n- 2026-11-06 x\n## Next\n"
    assert append_log(body, D, "x") == expected


def test_log_empty_section_and_missing_heading():
    assert append_log("## Maintenance log\n\n## Notes\n", D, "x") == "## Maintenance log\n- 2026-11-06 x\n\n## Notes\n"
    assert append_log("## Maintenance log", D, "x") == "## Maintenance log\n- 2026-11-06 x\n"
    assert append_log("\n## Notes\nn\n\n\n", D, "x") == "\n## Notes\nn\n\n## Maintenance log\n- 2026-11-06 x\n"
    assert append_log("", D, "x") == "\n## Maintenance log\n- 2026-11-06 x\n"


def test_log_text_is_one_line():
    assert append_log("", D, "  two\nlines\t here ").endswith("- 2026-11-06 two lines here\n")


# --- file names (DESIGN 15.3) -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Dishwasher", "Dishwasher"),
        ("Fridge/Freezer", "Fridge Freezer"),
        ("a\\b\x00c\nd", "a b c d"),
        ("..hidden", "hidden"),
        ("Boiler.", "Boiler"),
        ('What? <is> "this": *', "What is this"),
        ("CON", "Item"),
        ("nul.txt", "Item"),
        ("", "Item"),
        ("   ", "Item"),
        ("x~", "Item"),
        ("draft.tmp", "Item"),
        ("Ψυγείο", "Ψυγείο"),  # NFD in, NFC out
    ],
)
def test_clean_filename(name, expected):
    assert clean_filename(name) == expected


def test_clean_filename_limits_utf8_bytes_without_splitting_characters():
    out = clean_filename("ψ" * 200)
    assert len(out.encode()) <= 120 and out == "ψ" * 60


def test_unique_stem_counts_notes_and_attachment_folders():
    assert unique_stem("Fridge", set()) == "Fridge"
    assert unique_stem("Fridge", {"fridge.md"}) == "Fridge-2"
    assert unique_stem("Fridge", {"fridge.md", "fridge-2"}) == "Fridge-3"  # a folder blocks too
    assert unique_stem("Ψυγείο", {"ψυγείο.md"}) == "Ψυγείο-2"
