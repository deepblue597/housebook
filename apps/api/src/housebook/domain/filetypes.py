"""Content type from a file's first bytes (DESIGN 15.13). The extension is never trusted for
anything a browser would render inline."""

# (offset, magic, media type)
_MAGIC: tuple[tuple[int, bytes, str], ...] = (
    (0, b"%PDF-", "application/pdf"),
    (0, b"\x89PNG\r\n\x1a\n", "image/png"),
    (0, b"\xff\xd8\xff", "image/jpeg"),
    (0, b"GIF87a", "image/gif"),
    (0, b"GIF89a", "image/gif"),
)
_HEIF_BRANDS = {b"heic": "image/heic", b"heix": "image/heic", b"heif": "image/heif", b"mif1": "image/heif"}

SNIFF_BYTES = 16
INLINE_TYPES = frozenset({"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"})


def sniff(head: bytes) -> str | None:
    """Media type of PDF and raster images we know, else None."""
    for offset, magic, media_type in _MAGIC:
        if head[offset : offset + len(magic)] == magic:
            return media_type
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[4:8] == b"ftyp":
        return _HEIF_BRANDS.get(head[8:12])
    return None
