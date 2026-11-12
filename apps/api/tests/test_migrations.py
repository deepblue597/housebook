import pytest

from housebook.migrations.house import MigrationError, migrate


def test_current_version_passes_through():
    data = {"schemaVersion": 2, "grid": {}}
    m = migrate(data)
    assert m.data == data and not m.migrated and not m.read_only and m.original_version == 2
    assert m.data is not data  # never mutates the input


def test_newer_version_is_read_only():
    m = migrate({"schemaVersion": 7})
    assert m.read_only and not m.migrated and m.original_version == 7


def test_steps_run_in_order():
    calls = []

    def v1(d):
        calls.append(1)
        return {**d, "schemaVersion": 2, "a": True}

    def v2(d):
        calls.append(2)
        return {**d, "schemaVersion": 3, "b": d["a"]}

    m = migrate({"schemaVersion": 1}, current=3, migrations={1: v1, 2: v2})
    assert calls == [1, 2]
    assert m.data == {"schemaVersion": 3, "a": True, "b": True} and m.migrated and m.original_version == 1


def test_missing_step_and_bad_step():
    with pytest.raises(MigrationError, match="no migration from schemaVersion 1"):
        migrate({"schemaVersion": 1}, current=2, migrations={})
    with pytest.raises(MigrationError, match="did not set schemaVersion 2"):
        migrate({"schemaVersion": 1}, current=2, migrations={1: lambda d: d})


@pytest.mark.parametrize("data", [{}, {"schemaVersion": "1"}, {"schemaVersion": 0}, {"schemaVersion": True}, []])
def test_invalid_version(data):
    with pytest.raises(MigrationError):
        migrate(data)


def test_v1_to_v2_only_bumps_the_version():
    v1 = {"schemaVersion": 1, "grid": {"tileSize": 1}, "rooms": [{"id": "r", "name": "K", "color": "#000000"}]}
    m = migrate(v1)
    assert m.migrated and m.original_version == 1
    assert m.data == {**v1, "schemaVersion": 2}
