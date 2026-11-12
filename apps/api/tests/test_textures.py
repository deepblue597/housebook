"""Your own textures (milestone 9, part 3, D43): POST/DELETE /api/textures, GET /api/textures/{key},
`Textures/textures.json` and how rooms use the keys."""

import asyncio
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from conftest import ClientFactory
from housebook.adapters.fs import FsHouseRepo, FsTextureRepo, MarkdownNoteRepo
from housebook.domain.catalog import Catalog
from housebook.domain.finishes import Finishes
from housebook.domain.textures import ManifestError, parse_manifest
from housebook.services.indexer import Indexer
from housebook.services.sync import Hub, Sync, textures_version

OCTET = {"Content-Type": "application/octet-stream"}
MANIFEST = Path("Textures/textures.json")
GPS_IFD = 0x8825


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def image(fmt: str = "JPEG", size: tuple[int, int] = (64, 32), color: tuple[int, int, int] = (200, 100, 50)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, fmt)
    return out.getvalue()


def upload(c: TestClient, data: bytes, **params: object):
    query = {"kind": "floor", "label": "Marble", "width": 0.6, "height": 0.6} | params
    return c.post("/api/textures", params=query, content=data, headers=OCTET)


def manifest(root: Path) -> dict:
    return json.loads((root / MANIFEST).read_text())


def kinds(c: TestClient) -> list[str]:
    return [p["kind"] for p in c.get("/api/problems").json()["problems"]]


def set_room(c: TestClient, **finish: str) -> None:
    r = c.get("/api/house")
    data = r.json()
    data["rooms"][0].update(finish)
    put = c.put("/api/house", json=data, headers={"If-Match": r.headers["etag"]})
    assert put.status_code == 200, put.text


def test_upload_stores_the_image_lists_it_and_returns_its_key(editor: TestClient, example_root: Path):
    r = upload(editor, image(color=(200, 100, 50)), label="Grey marble", width=0.6, height=0.3)
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["key"].startswith("my_") and t["kind"] == "floor" and t["label"] == "Grey marble"
    assert t["size"] == [0.6, 0.3] and t["color"] == "#c86432"
    assert t["url"].startswith(f"/api/textures/{t['key']}?v=") and r.headers["location"] == t["url"]
    assert manifest(example_root) == {
        "version": 1,
        "textures": [
            {
                "key": t["key"],
                "label": "Grey marble",
                "kind": "floor",
                "file": "Grey marble.jpg",
                "size": [0.6, 0.3],
                "color": "#c86432",
            }
        ],
    }
    assert (example_root / "Textures" / "Grey marble.jpg").is_file()
    assert not list((example_root / ".housebook" / "uploads").iterdir())
    snap = editor.get("/api/snapshot").json()
    assert snap["textures"] == [t] and snap["texturesVersion"]


def test_the_image_is_served_and_its_url_changes_with_the_file(editor: TestClient, example_root: Path):
    t = upload(editor, image("PNG")).json()
    r = editor.get(t["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    (example_root / "Textures" / "Marble.png").write_bytes(image("PNG", size=(10, 10)))
    editor.app.state.ctx.indexer.scan()  # as the watcher would
    again = next(x for x in editor.get("/api/snapshot").json()["textures"] if x["key"] == t["key"])
    assert again["url"] != t["url"]


def test_large_images_are_shrunk_and_metadata_dropped(editor: TestClient, example_root: Path):
    img = Image.new("RGB", (3000, 1500), (10, 20, 30))
    exif = img.getexif()
    exif[0x010F] = "PhoneMaker"
    exif.get_ifd(GPS_IFD)[1] = "N"
    out = io.BytesIO()
    img.save(out, "JPEG", exif=exif)
    assert upload(editor, out.getvalue()).status_code == 201
    with Image.open(example_root / "Textures" / "Marble.jpg") as stored:
        assert stored.size == (1024, 512)
        assert not stored.getexif()


def test_same_label_gets_a_new_file_name(editor: TestClient, example_root: Path):
    a, b = upload(editor, image()).json(), upload(editor, image()).json()
    upload(editor, image("PNG"))  # another extension: no clash
    assert a["key"] != b["key"]
    assert [t["file"] for t in manifest(example_root)["textures"]] == ["Marble.jpg", "Marble-2.jpg", "Marble.png"]


@pytest.mark.parametrize(
    ("data", "params", "headers", "code"),
    [
        (b"%PDF-1.4\n%%EOF\n", {}, OCTET, 415),
        (b"just text", {}, OCTET, 415),
        (b"", {}, OCTET, 422),
        (image(), {}, {"Content-Type": "image/jpeg"}, 415),
        (image(), {"width": 0}, OCTET, 422),
        (image(), {"height": 21}, OCTET, 422),
        (image(), {"kind": "ceiling"}, OCTET, 422),
        (image(), {"label": "x" * 61}, OCTET, 422),
        (image(), {"label": "  "}, OCTET, 422),
        (image(), {"label": "a\x07b"}, OCTET, 422),
    ],
)
def test_bad_uploads_are_refused_and_leave_nothing(
    editor: TestClient, example_root: Path, data: bytes, params: dict, headers: dict, code: int
):
    query = {"kind": "floor", "label": "Marble", "width": 1, "height": 1} | params
    r = editor.post("/api/textures", params=query, content=data, headers=headers)
    assert r.status_code == code, r.text
    assert not (example_root / "Textures").exists()


def test_viewers_cannot_upload_or_delete(example_root: Path, make_client: ClientFactory):
    viewer = make_client(example_root)
    assert upload(viewer, image()).status_code == 403
    assert viewer.delete("/api/textures/my_abc123").status_code == 403


def test_rooms_can_use_own_keys_of_the_right_kind(editor: TestClient):
    floor = upload(editor, image()).json()["key"]
    paper = upload(editor, image(), kind="wallpaper", label="Roses").json()["key"]
    set_room(editor, floor=floor, walls=paper)
    assert "house_unknown_finish" not in kinds(editor)
    set_room(editor, floor=paper, walls=floor)  # swapped: a wallpaper isn't a floor
    assert kinds(editor).count("house_unknown_finish") == 2


def test_delete_refuses_while_a_room_uses_it_then_moves_the_file_to_the_trash(editor: TestClient, example_root: Path):
    key = upload(editor, image()).json()["key"]
    set_room(editor, floor=key)
    r = editor.delete(f"/api/textures/{key}")
    assert r.status_code == 409 and r.json()["reason"] == "in_use"
    set_room(editor, floor="oak")
    assert editor.delete(f"/api/textures/{key}").status_code == 204
    assert manifest(example_root)["textures"] == []
    assert not (example_root / "Textures" / "Marble.jpg").exists()
    trashed = list((example_root / ".housebook" / "trash").glob("*-texture/Marble.jpg"))
    assert len(trashed) == 1
    assert editor.get(f"/api/textures/{key}").status_code == 404
    assert editor.delete(f"/api/textures/{key}").status_code == 404


def test_a_broken_manifest_is_an_error_and_blocks_uploads(editor: TestClient, example_root: Path):
    key = upload(editor, image()).json()["key"]
    set_room(editor, floor=key)
    (example_root / MANIFEST).write_text("{ not json")
    r = upload(editor, image(), label="Other")
    assert r.status_code == 409 and r.json()["reason"] == "textures_invalid"
    assert (example_root / MANIFEST).read_text() == "{ not json"  # never overwritten
    editor.app.state.ctx.indexer.scan()  # as the watcher would
    assert "textures_invalid" in kinds(editor)
    # The last valid list is kept, so the room keeps its finish meanwhile.
    assert [t["key"] for t in editor.get("/api/snapshot").json()["textures"]] == [key]
    assert "house_unknown_finish" not in kinds(editor)


def test_a_missing_image_is_a_warning_and_has_no_url(editor: TestClient, example_root: Path):
    key = upload(editor, image()).json()["key"]
    (example_root / "Textures" / "Marble.jpg").unlink()
    editor.app.state.ctx.indexer.scan()  # as the watcher would
    t = next(x for x in editor.get("/api/snapshot").json()["textures"] if x["key"] == key)
    assert t["url"] is None
    assert "texture_missing" in kinds(editor)
    assert editor.get(f"/api/textures/{key}").status_code == 404


def test_a_hand_placed_non_image_is_not_served(editor: TestClient, example_root: Path):
    key = upload(editor, image()).json()["key"]
    (example_root / "Textures" / "Marble.jpg").write_text("<script>alert(1)</script>")
    assert editor.get(f"/api/textures/{key}").status_code == 404


@pytest.mark.parametrize(
    "bad",
    [
        {"version": 2, "textures": []},
        {
            "textures": [
                {"key": "oak", "label": "x", "kind": "floor", "file": "a.jpg", "size": [1, 1], "color": "#000000"}
            ]
        },
        {
            "textures": [
                {"key": "my_a", "label": "x", "kind": "floor", "file": "../a.jpg", "size": [1, 1], "color": "#000000"}
            ]
        },
        {
            "textures": [
                {"key": "my_a", "label": "x", "kind": "floor", "file": "a.jpg", "size": [0, 1], "color": "#000000"}
            ]
        },
        {
            "textures": [
                {"key": "my_a", "label": "x", "kind": "floor", "file": "a.jpg", "size": [1, 1], "color": "#000000"},
                {"key": "my_a", "label": "y", "kind": "floor", "file": "b.jpg", "size": [1, 1], "color": "#000000"},
            ]
        },
    ],
)
def test_manifest_rules(bad: dict):
    with pytest.raises(ManifestError):
        parse_manifest(json.dumps(bad).encode())


def test_built_in_finishes_may_not_use_the_own_prefix():
    with pytest.raises(ValueError, match="my_"):
        Finishes.model_validate(
            {
                "floors": [{"key": "my_oak", "label": "Oak", "color": "#000000"}],
                "wallpapers": [],
                "paints": [],
                "exteriorDefault": "#000000",
            }
        )


def test_a_texture_change_is_announced_once(example_root: Path, catalog: Catalog):
    async def main() -> None:
        indexer = Indexer(
            FsHouseRepo(example_root),
            MarkdownNoteRepo(example_root, "House"),
            catalog,
            None,
            FsTextureRepo(example_root),
        )
        hub = Hub()
        sync = Sync(indexer, hub)
        await sync.rescan()  # first scan: announces nothing
        sub = hub.subscribe()
        (example_root / "Textures").mkdir()
        (example_root / "Textures" / "a.jpg").write_bytes(image())
        entry = {"key": "my_a", "label": "A", "kind": "floor", "file": "a.jpg", "size": [1, 1], "color": "#000000"}
        (example_root / MANIFEST).write_text(json.dumps({"version": 1, "textures": [entry]}))
        state = await sync.rescan()
        await sync.rescan()  # nothing new
        frames = []
        while not sub.queue.empty():
            frame = sub.queue.get_nowait()
            assert frame is not None
            frames.append(frame)
        sync.close()
        changed = [f for f in frames if f.startswith("event: textures.changed")]
        assert changed == [f'event: textures.changed\ndata: {{"version":"{textures_version(state)}"}}\n\n']

    asyncio.run(main())
