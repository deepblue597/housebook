"""Uploading and deleting attachments (milestone 6, D33): POST/DELETE /api/items/{id}/attachments."""

import io
from pathlib import Path

import pillow_heif
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import vault_builders as vb
from conftest import ClientFactory
from housebook.domain.frontmatter import parse

DISH = "it_7f3k2a"
DISH_NOTE = "House/Kitchen/Dishwasher.md"
FOLDER = "House/Kitchen/Dishwasher"
OCTET = {"Content-Type": "application/octet-stream"}
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
GPS_IFD = 0x8825
ORIENTATION = 0x0112


@pytest.fixture
def editor(example_root: Path, make_client: ClientFactory) -> TestClient:
    return make_client(example_root, anon_role="editor")


def upload(c: TestClient, name: str, data: bytes, item: str = DISH, **headers: str):
    return c.post(f"/api/items/{item}/attachments", params={"name": name}, content=data, headers=OCTET | headers)


def attachments_of(root: Path, rel: str = DISH_NOTE) -> object:
    return parse((root / rel).read_bytes()).data.get("attachments")


def leftovers(root: Path) -> list[str]:
    uploads = root / ".housebook" / "uploads"
    return sorted(p.name for p in uploads.iterdir()) if uploads.exists() else []


def jpeg_with_gps(size: tuple[int, int] = (40, 20), orientation: int = 6) -> bytes:
    img = Image.new("RGB", size, (30, 120, 200))
    exif = img.getexif()
    exif[ORIENTATION] = orientation
    exif[0x010F] = "PhoneMaker"  # camera make
    gps = exif.get_ifd(GPS_IFD)
    gps[1] = "N"
    gps[2] = (37.0, 58.0, 30.0)
    gps[3] = "E"
    gps[4] = (23.0, 43.0, 10.0)
    out = io.BytesIO()
    img.save(out, "JPEG", exif=exif)
    return out.getvalue()


def image_bytes(fmt: str, size: tuple[int, int] = (20, 10), mode: str = "RGB") -> bytes:
    out = io.BytesIO()
    Image.new(mode, size).save(out, fmt)
    return out.getvalue()


def heic_bytes() -> bytes:
    out = io.BytesIO()
    pillow_heif.from_pillow(Image.new("RGB", (64, 48), (200, 10, 10))).save(out, quality=80)
    return out.getvalue()


# --- upload -------------------------------------------------------------------------------------


def test_pdf_is_stored_as_sent_in_the_items_folder_and_listed(editor: TestClient, example_root: Path):
    before = (example_root / DISH_NOTE).read_text(encoding="utf-8")
    r = upload(editor, "Invoice 2024.pdf", PDF)
    assert r.status_code == 201, r.text
    assert r.headers["location"] == f"/api/items/{DISH}/attachments/Invoice%202024.pdf"
    assert (example_root / FOLDER / "Invoice 2024.pdf").read_bytes() == PDF
    assert attachments_of(example_root) == ["[[Dishwasher/manual.pdf]]", "[[Dishwasher/Invoice 2024.pdf]]"]
    assert "Invoice 2024.pdf" in [a["name"] for a in r.json()["attachments"]]
    # Minimal diff: only the attachments line changed.
    after = (example_root / DISH_NOTE).read_text(encoding="utf-8")
    changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines(), strict=True) if a != b]
    assert changed == [
        (
            'attachments: ["[[Dishwasher/manual.pdf]]"]',
            'attachments: ["[[Dishwasher/manual.pdf]]", "[[Dishwasher/Invoice 2024.pdf]]"]',
        )
    ]
    assert leftovers(example_root) == []


def test_name_collisions_get_a_number_and_the_extension_follows_the_content(editor: TestClient, example_root: Path):
    assert upload(editor, "manual.pdf", PDF).status_code == 201
    assert (example_root / FOLDER / "manual-2.pdf").read_bytes() == PDF
    # A PNG named .jpg is stored as .png; an existing receipt.png makes it receipt-2.png.
    assert upload(editor, "receipt.jpg", image_bytes("PNG")).status_code == 201
    assert Image.open(example_root / FOLDER / "receipt-2.png").format == "PNG"


def test_unsafe_names_are_cleaned(editor: TestClient, example_root: Path):
    assert upload(editor, "../../etc/passwd.pdf", PDF).status_code == 201
    stored = sorted(p.name for p in (example_root / FOLDER).iterdir())
    assert stored == ["etc passwd.pdf", "manual.pdf", "receipt.png"]
    assert not (example_root / "etc").exists()


def test_photos_lose_gps_and_other_metadata_and_keep_their_orientation(editor: TestClient, example_root: Path):
    assert upload(editor, "plate.jpg", jpeg_with_gps((40, 20), orientation=6)).status_code == 201
    with Image.open(example_root / FOLDER / "plate.jpg") as img:
        assert img.format == "JPEG"
        assert img.size == (20, 40)  # rotated 90° as the camera said, then the tag dropped
        exif = img.getexif()
        assert not exif.get_ifd(GPS_IFD)
        assert ORIENTATION not in exif and 0x010F not in exif


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"])
def test_png_and_webp_keep_their_format(editor: TestClient, example_root: Path, fmt: str):
    assert upload(editor, f"x.{fmt.lower()}", image_bytes(fmt)).status_code == 201
    ext = ".png" if fmt == "PNG" else ".webp"
    assert Image.open(example_root / FOLDER / f"x{ext}").format == fmt


def test_heic_becomes_jpeg(editor: TestClient, example_root: Path):
    r = upload(editor, "IMG_0042.HEIC", heic_bytes())
    assert r.status_code == 201, r.text
    with Image.open(example_root / FOLDER / "IMG_0042.jpg") as img:
        assert img.format == "JPEG" and img.size == (64, 48)
    assert "[[Dishwasher/IMG_0042.jpg]]" in attachments_of(example_root)  # type: ignore[operator]


@pytest.mark.parametrize(
    "data",
    [b"just text", b"<svg xmlns='http://www.w3.org/2000/svg'/>", b"GIF89a" + b"\0" * 20, b"PK\x03\x04zip"],
    ids=["text", "svg", "gif", "zip"],
)
def test_other_types_are_refused_and_nothing_is_written(editor: TestClient, example_root: Path, data: bytes):
    before = (example_root / DISH_NOTE).read_bytes()
    r = upload(editor, "x.pdf", data)
    assert r.status_code == 415
    assert "PDF, JPEG, PNG, WebP or HEIC" in r.json()["detail"]
    assert (example_root / DISH_NOTE).read_bytes() == before
    assert sorted(p.name for p in (example_root / FOLDER).iterdir()) == ["manual.pdf", "receipt.png"]
    assert leftovers(example_root) == []


def test_a_damaged_image_is_refused(editor: TestClient, example_root: Path):
    r = upload(editor, "x.jpg", b"\xff\xd8\xff\xe0" + b"garbage" * 50)
    assert r.status_code == 422
    assert leftovers(example_root) == []


def test_a_decompression_bomb_is_refused(editor: TestClient, example_root: Path):
    # 10 000 × 9 000 = 90 megapixels in a few kilobytes of PNG.
    r = upload(editor, "bomb.png", image_bytes("PNG", (10_000, 9_000), mode="1"))
    assert r.status_code == 422
    assert "too large" in r.json()["detail"]
    assert leftovers(example_root) == []


def test_viewers_can_neither_upload_nor_delete(client: TestClient):
    assert upload(client, "x.pdf", PDF).status_code == 403
    assert client.delete(f"/api/items/{DISH}/attachments/manual.pdf").status_code == 403


def test_request_hygiene(editor: TestClient, example_root: Path):
    for ctype in ("application/pdf", "multipart/form-data; boundary=x", "application/json", "text/plain"):
        assert upload(editor, "x.pdf", PDF, **{"Content-Type": ctype}).status_code == 415
    assert upload(editor, "x.pdf", PDF, item="it_nope").status_code == 404
    assert upload(editor, "x.pdf", b"").status_code == 422
    assert upload(editor, "a\nb.pdf", PDF).status_code == 422
    r = editor.post(f"/api/items/{DISH}/attachments", content=PDF, headers=OCTET)
    assert r.status_code == 422  # no name
    assert leftovers(example_root) == []


def test_too_large_is_413_and_leaves_nothing(editor: TestClient, example_root: Path):
    r = upload(editor, "big.pdf", PDF + b"\0" * (25 * 1024 * 1024))
    assert r.status_code == 413
    assert leftovers(example_root) == []
    assert sorted(p.name for p in (example_root / FOLDER).iterdir()) == ["manual.pdf", "receipt.png"]


def test_first_attachment_creates_the_folder_and_the_key(editor: TestClient, example_root: Path):
    vb.item(example_root, "it_new", "name: Kettle", rel="House/Kitchen/Kettle.md")
    editor.post(f"/api/items/{DISH}/log", json={"text": "x"})  # any write rescans (the watcher is off)
    r = upload(editor, "k.pdf", PDF, item="it_new")
    assert r.status_code == 201, r.text
    assert (example_root / "House/Kitchen/Kettle/k.pdf").read_bytes() == PDF
    assert attachments_of(example_root, "House/Kitchen/Kettle.md") == ["[[Kettle/k.pdf]]"]


def test_an_unparseable_note_refuses_uploads(editor: TestClient, example_root: Path):
    note = example_root / DISH_NOTE
    note.write_text(note.read_text(encoding="utf-8").replace("name: Dishwasher", "name: [unclosed"), encoding="utf-8")
    r = upload(editor, "x.pdf", PDF)
    assert r.status_code == 409 and r.json()["reason"] == "unparseable"
    assert sorted(p.name for p in (example_root / FOLDER).iterdir()) == ["manual.pdf", "receipt.png"]
    assert leftovers(example_root) == []


# --- delete -------------------------------------------------------------------------------------


def trash(root: Path) -> list[str]:
    t = root / ".housebook" / "trash"
    return sorted(str(p.relative_to(t)) for p in t.rglob("*") if p.is_file()) if t.exists() else []


def test_delete_moves_the_file_to_the_trash_and_unlists_it(editor: TestClient, example_root: Path):
    r = editor.delete(f"/api/items/{DISH}/attachments/manual.pdf")
    assert r.status_code == 200, r.text
    assert not (example_root / FOLDER / "manual.pdf").exists()
    assert [p.split("/", 1)[1] for p in trash(example_root)] == ["manual.pdf"]
    assert trash(example_root)[0].split("/")[0].endswith(f"-{DISH}-attachment")
    assert attachments_of(example_root) is None  # the only link: the key goes
    assert "manual.pdf" not in [a["name"] for a in r.json()["attachments"]]


def test_delete_of_an_unlisted_file_in_the_folder_leaves_the_note_alone(editor: TestClient, example_root: Path):
    before = (example_root / DISH_NOTE).read_bytes()
    assert editor.delete(f"/api/items/{DISH}/attachments/receipt.png").status_code == 200
    assert (example_root / DISH_NOTE).read_bytes() == before
    assert not (example_root / FOLDER / "receipt.png").exists()


def test_delete_keeps_other_links(editor: TestClient, example_root: Path):
    assert upload(editor, "warranty.pdf", PDF).status_code == 201
    assert editor.delete(f"/api/items/{DISH}/attachments/warranty.pdf").status_code == 200
    assert attachments_of(example_root) == ["[[Dishwasher/manual.pdf]]"]


def test_files_outside_the_items_folder_are_not_deleted(editor: TestClient, example_root: Path):
    vb.write(example_root, "Manuals/shared.pdf", PDF)
    note = example_root / DISH_NOTE
    note.write_text(
        note.read_text(encoding="utf-8").replace(
            'attachments: ["[[Dishwasher/manual.pdf]]"]', 'attachments: ["[[Dishwasher/manual.pdf]]", "[[shared.pdf]]"]'
        ),
        encoding="utf-8",
    )
    editor.post(f"/api/items/{DISH}/log", json={"text": "x"})  # rescan
    r = editor.delete(f"/api/items/{DISH}/attachments/shared.pdf")
    assert r.status_code == 409 and r.json()["reason"] == "not_in_folder"
    assert (example_root / "Manuals/shared.pdf").exists()


def test_delete_hygiene(editor: TestClient):
    assert editor.delete(f"/api/items/{DISH}/attachments/nope.pdf").status_code == 404
    assert editor.delete("/api/items/it_nope/attachments/manual.pdf").status_code == 404
    assert editor.delete(f"/api/items/{DISH}/attachments/.hidden").status_code == 400
