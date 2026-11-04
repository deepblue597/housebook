"""Shared golden fixtures (contract/fixtures). The frontend runs the same files in vitest."""

from datetime import date, datetime

import pytest

from conftest import load_fixture
from housebook.domain.item import Interval, error_codes
from housebook.domain.search import SearchDoc, search
from housebook.domain.status import compute_status, today_in
from housebook.domain.text import fold

STATUS = load_fixture("status_cases.json")
SEARCH = load_fixture("search_cases.json")


def _d(s: str | None) -> date | None:
    return date.fromisoformat(s) if s else None


@pytest.mark.parametrize("case", STATUS["cases"], ids=lambda c: c["name"])
def test_status(case: dict):
    item = case["item"]
    status = compute_status(
        _d(case["today"]),
        next_check=_d(item.get("next_check")),
        warranty_until=_d(item.get("warranty_until")),
        check_every=Interval.parse(item["check_every"]) if item.get("check_every") else None,
        last_service=_d(item.get("last_service")),
        purchased=_d(item.get("purchased")),
    )
    assert status.model_dump(mode="json") == case["expect"]


@pytest.mark.parametrize("case", STATUS["today_cases"], ids=lambda c: c["name"])
def test_today_in_household_tz(case: dict):
    now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
    assert today_in(case["tz"], now).isoformat() == case["today"]


@pytest.mark.parametrize("case", STATUS["interval_cases"], ids=lambda c: repr(c["input"]))
def test_interval_parsing(case: dict):
    if case["valid"]:
        Interval.parse(case["input"])
    else:
        with pytest.raises(ValueError):
            Interval.parse(case["input"])


@pytest.mark.parametrize("pair", SEARCH["fold_cases"], ids=lambda p: p[0])
def test_fold(pair: list[str]):
    assert fold(pair[0]) == pair[1]


@pytest.mark.parametrize("case", SEARCH["error_code_cases"])
def test_error_code_extraction(case: dict):
    assert error_codes(case["body"]) == case["codes"]


DOCS = [
    SearchDoc(
        id=i["id"],
        name=i["name"],
        error_codes=tuple(error_codes(i["body"])),
        model=i["model"],
        brand=i["brand"],
        serial=i["serial"],
        type_label=i["type_label"],
        room=i["room"],
        body=i["body"],
    )
    for i in SEARCH["items"]
]


@pytest.mark.parametrize("case", SEARCH["cases"], ids=lambda c: repr(c["q"]))
def test_search(case: dict):
    assert search(DOCS, case["q"]) == case["expect"]
