"""Receipts linked from Paperless-ngx (D52, data contract §3.7).

A note lists them as the documents' Paperless addresses, `receipts:
["https://paperless.example/documents/1234/details"]`, so they stay clickable in Obsidian. A link
counts as a Paperless document when it starts with one of the configured Paperless addresses
followed by `/documents/<id>`; any other link is kept and shown as a plain link.
"""

import re
from collections.abc import Sequence
from urllib.parse import urlsplit

_DOC_PATH_RE = re.compile(r"/documents/([1-9][0-9]{0,11})(?:/[^?#]*)?")


def document_id(link: str, bases: Sequence[str]) -> int | None:
    """The Paperless document id `link` points to, when it is on one of `bases`."""
    try:
        parts = urlsplit(link.strip())
    except ValueError:
        return None
    for base in bases:
        b = urlsplit(base)
        if parts.scheme.lower() != b.scheme.lower() or parts.netloc.lower() != b.netloc.lower():
            continue
        if not parts.path.startswith(b.path):
            continue
        m = _DOC_PATH_RE.fullmatch(parts.path[len(b.path) :])
        if m:
            return int(m[1])
    return None


def document_url(base: str, doc_id: int) -> str:
    """The address of a document's page in Paperless, as stored in notes."""
    return f"{base}/documents/{doc_id}/details"
