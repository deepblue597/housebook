"""Prepare an uploaded file before it joins an item's attachments (DESIGN 15.13, D33).

The type comes from the file's first bytes, never its name or the client's Content-Type. Allowed:
PDF (stored as sent), JPEG, PNG, WebP and HEIC/HEIF. Images are decoded and saved again: the
orientation from EXIF is applied, and every piece of metadata (EXIF with GPS coordinates, XMP,
comments) is dropped; only the colour profile is kept. HEIC/HEIF becomes JPEG, since only Safari
shows HEIC.
"""

import os
import secrets
import warnings
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

from housebook.domain.filetypes import SNIFF_BYTES, sniff

register_heif_opener()

# A 12-megapixel phone photo is 12 M; a scanned A3 page at 600 dpi about 70 M. Bigger is
# either absurd or a decompression bomb (a small file that decodes to gigabytes).
MAX_PIXELS = 80_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

# Sniffed type -> extension of the stored file.
EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".jpg",
    "image/heif": ".jpg",
}
ALLOWED_DESCRIPTION = "PDF, JPEG, PNG, WebP or HEIC"


class UploadRejected(Exception):
    """The file can't be stored; `status` is the HTTP status (415 wrong type, 422 broken)."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Prepared:
    path: Path  # the file to store (the upload itself for PDFs, else a new temp file)
    extension: str
    media_type: str  # what was uploaded (sniffed)


def prepare(upload: Path) -> Prepared:
    """Check and clean an uploaded file. Any new file is created next to `upload` (same
    filesystem, so it can be moved into place by rename); the caller deletes both."""
    with upload.open("rb") as f:
        media_type = sniff(f.read(SNIFF_BYTES))
    if media_type not in EXTENSIONS:
        raise UploadRejected(415, f"only {ALLOWED_DESCRIPTION} files can be attached")
    extension = EXTENSIONS[media_type]
    if media_type == "application/pdf":
        return Prepared(upload, extension, media_type)
    out = upload.with_name(f".{secrets.token_hex(6)}{extension}.tmp")
    try:
        _clean_image(upload, out, extension)
    except BaseException:
        out.unlink(missing_ok=True)
        raise
    return Prepared(out, extension, media_type)


def _clean_image(src: Path, dst: Path, extension: str, max_side: int | None = None) -> str | None:
    """Decode, fix the orientation, drop the metadata and save. With `max_side`, also shrink to
    fit it and return the average colour (`#rrggbb`)."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(src) as img:
                img.load()
                icc = img.info.get("icc_profile")
                # Orientation lives in EXIF, which is dropped: bake it into the pixels.
                fixed = ImageOps.exif_transpose(img)
                color = None
                if max_side:
                    fixed.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                    color = average_color(fixed)
                _save(fixed, dst, extension, icc)
                return color
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
        raise UploadRejected(422, f"the image is too large (more than {MAX_PIXELS // 1_000_000} megapixels)") from e
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as e:
        # Truncated or corrupt data, or a format variant Pillow can't decode.
        raise UploadRejected(422, "the image can't be read; it may be damaged") from e


def average_color(img: Image.Image) -> str:
    """Mean colour over the image (transparent pixels count as they are drawn: their colour)."""
    r, g, b = img.convert("RGB").resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))  # type: ignore[misc]
    return f"#{r:02x}{g:02x}{b:02x}"


# --- textures (D43) ----------------------------------------------------------------------------

# Built-in textures are 512 px (D42). Twice that keeps a photo of a wallpaper sharp up close
# and is still small for a phone: a few hundred KB.
TEXTURE_MAX_SIDE = 1024
TEXTURE_TYPES = {k: v for k, v in EXTENSIONS.items() if k != "application/pdf"}


@dataclass(frozen=True)
class PreparedTexture:
    path: Path
    extension: str
    color: str


def prepare_texture(upload: Path) -> PreparedTexture:
    """Check, clean and shrink an image uploaded as a texture. Like `prepare`, the new file is
    created next to `upload`; the caller deletes both."""
    with upload.open("rb") as f:
        media_type = sniff(f.read(SNIFF_BYTES))
    if media_type not in TEXTURE_TYPES:
        raise UploadRejected(415, "only JPEG, PNG, WebP or HEIC images can be textures")
    extension = TEXTURE_TYPES[media_type]
    out = upload.with_name(f".{secrets.token_hex(6)}{extension}.tmp")
    try:
        color = _clean_image(upload, out, extension, max_side=TEXTURE_MAX_SIDE)
    except BaseException:
        out.unlink(missing_ok=True)
        raise
    assert color is not None
    return PreparedTexture(out, extension, color)


def _save(img: Image.Image, dst: Path, extension: str, icc: bytes | None) -> None:
    extra = {"icc_profile": icc} if icc else {}
    if extension == ".jpg":
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(dst, "JPEG", quality=90, optimize=True, **extra)
    elif extension == ".png":
        img.save(dst, "PNG", optimize=True, **extra)
    else:
        img.save(dst, "WEBP", quality=90, method=4, **extra)
    with dst.open("rb+") as f:
        os.fsync(f.fileno())
