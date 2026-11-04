from datetime import date

import pytest

from housebook.domain.frontmatter import FrontmatterError, is_housebook_tagged, parse, tags_of
from housebook.domain.item import Interval, error_codes, last_log_date, parse_fields


def test_crlf_and_bom_are_normalised():
    raw = "﻿---\r\nname: Fridge\r\n---\r\nline 1\r\nline 2\r\n".encode()
    p = parse(raw)
    assert p.has_frontmatter
    assert p.data == {"name": "Fridge"}
    assert p.body == "line 1\nline 2\n"


def test_no_frontmatter():
    p = parse(b"# Title\n\ntext\n")
    assert not p.has_frontmatter and p.data == {} and p.body == "# Title\n\ntext\n"


def test_frontmatter_must_start_on_first_line():
    p = parse(b"\n---\nname: x\n---\n")
    assert not p.has_frontmatter


def test_empty_frontmatter():
    assert parse(b"---\n---\nbody").data == {}


@pytest.mark.parametrize(
    "raw, message",
    [
        (b"---\nname: Ha", "not closed"),
        (b"---\nname: [unclosed\n---\n", "invalid YAML (line 2)"),
        (b"---\n- a\n- b\n---\n", "not a key/value mapping"),
        (b"---\nname: caf\xe9\n---\n", "not valid UTF-8"),
    ],
)
def test_parse_errors(raw: bytes, message: str):
    with pytest.raises(FrontmatterError, match=message.replace("(", r"\(").replace(")", r"\)")):
        parse(raw)


def test_every_value_is_a_string():
    p = parse(b"---\nserial: 0123\nmodel: no\nbrand: 1e3\nname: 0x1F\npurchased: 2024-05-10\ncritical: yes\n---\n")
    assert p.data == {
        "serial": "0123",
        "model": "no",
        "brand": "1e3",
        "name": "0x1F",
        "purchased": "2024-05-10",
        "critical": "yes",
    }


def test_body_with_horizontal_rules_is_kept():
    p = parse(b"---\nname: x\n---\nabove\n\n---\n\nbelow\n")
    assert p.body == "above\n\n---\n\nbelow\n"


@pytest.mark.parametrize(
    "yaml_text, tagged",
    [
        ("tags: housebook", True),
        ("tags: [housebook]", True),
        ("tags: [other, housebook]", True),
        ('tags:\n  - "#housebook"', True),
        ("tags:\n  - kitchen\n  - housebook", True),
        ("tags: '#housebook, kitchen'", True),
        ("tags: kitchen housebook", True),
        ("tag: Housebook", True),
        ("tags: [housebook/appliance]", True),
        ("tags: [HOUSEBOOK]", True),
        ("tags: [housebooks]", False),
        ("tags: [my-housebook]", False),
        ("tags: []", False),
        ("tags:", False),
        ("name: no tags", False),
    ],
)
def test_tag_forms(yaml_text: str, tagged: bool):
    data = parse(f"---\n{yaml_text}\n---\n".encode()).data
    assert is_housebook_tagged(data) is tagged


def test_tags_of_strips_hash():
    assert tags_of({"tags": ["#a", "b"], "tag": "#c, d"}) == ["a", "b", "c", "d"]


def test_parse_fields_types_and_unknown_keys():
    raw = parse(
        b"---\nhousebook_id: it_7f3k2a\ntype: dishwasher\nserial: 0123\npurchased: 2024-05-10\n"
        b"warranty_until: 2027-05-10T00:00:00\ncheck_every: 6m\ncritical: yes\nmanual: https://x.example\n"
        b"aliases: [Dish]\ncssclasses: wide\n---\n"
    ).data
    fields, errors = parse_fields(raw)
    assert errors == []
    assert fields.housebook_id == "it_7f3k2a"
    assert fields.serial == "0123"
    assert fields.purchased == date(2024, 5, 10)
    assert fields.warranty_until == date(2027, 5, 10)
    assert fields.check_every == Interval(count=6, unit="m")
    assert fields.critical is True
    # Unknown keys are not dropped from the raw dict (kept on write in milestone 4).
    assert raw["aliases"] == ["Dish"] and raw["cssclasses"] == "wide"


def test_bad_fields_are_dropped_individually():
    raw = {
        "housebook_id": "it_ok0001",
        "name": "Ok",
        "next_check": "soon",
        "warranty_until": "2027-13-45",
        "check_every": "weekly",
        "manual": "javascript:alert(1)",
        "support": "https://ok.example",
        "critical": "maybe",
        "brand": ["a", "b"],
    }
    fields, errors = parse_fields(raw)
    assert {e.key for e in errors} == {"next_check", "warranty_until", "check_every", "manual", "critical", "brand"}
    assert fields.name == "Ok" and fields.support == "https://ok.example"
    assert fields.next_check is None and fields.manual is None


@pytest.mark.parametrize("value", ["bad id!", "has space", "x" * 65, "ü-umlaut"])
def test_invalid_id(value: str):
    fields, errors = parse_fields({"housebook_id": value})
    assert fields.housebook_id is None
    assert [e.key for e in errors] == ["housebook_id"]


def test_empty_values_are_none():
    fields, errors = parse_fields({"brand": "", "next_check": "", "check_every": "null", "critical": "~"})
    assert errors == []
    assert fields.brand is None and fields.next_check is None and fields.check_every is None and fields.critical is None


def test_unquoted_wikilink_is_flattened():
    data = parse(b"---\nattachments: [[Dishwasher/manual.pdf]]\n---\n").data
    fields, _ = parse_fields(data)
    assert fields.attachments == ["[[Dishwasher/manual.pdf]]"]


def test_error_codes_and_log_dates():
    body = (
        "## Quick help\n- **E15**: water\n- **OE** drain\n- plain\n\n"
        "## Maintenance log\n- 2026-03-02 Descaled\n- 2026-09-15 Pump (85 €)\n- not a date\n\n"
        "## Notes\n- 2027-01-01 not in the log\n"
    )
    assert error_codes(body) == ["E15", "OE"]
    assert last_log_date(body) == date(2026, 9, 15)
    assert last_log_date("no log") is None
