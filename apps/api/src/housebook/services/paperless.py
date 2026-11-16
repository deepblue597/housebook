"""Paperless-ngx client for linked receipts (D52, data contract §8.4).

Only the backend talks to Paperless and only it holds the token. It calls the configured address
and nothing else: document ids are integers, redirects are refused (urllib would otherwise send
the token on to wherever a redirect points), and answers are size-limited.

Calls are blocking (urllib); routes run them in a thread. Tests pass their own `Http`.
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

from housebook import __version__
from housebook.config import Settings
from housebook.domain.receipts import document_url

TIMEOUT = 10.0
MAX_JSON = 4 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024  # a long scanned PDF
DOC_TTL = 600.0  # seconds a document's title and date (or its absence) are remembered
SEARCH_SIZE = 24
FIELDS = "id,title,created,original_file_name"


class PaperlessError(Exception):
    """Paperless couldn't be reached or answered something unusable. The message is for logs and
    error responses; it never contains the token."""


class TooLarge(PaperlessError):
    pass


@dataclass(frozen=True)
class Answer:
    status: int
    content_type: str
    body: bytes


class Http(Protocol):
    def get(self, url: str, headers: dict[str, str], limit: int) -> Answer: ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # a 3xx stays a 3xx answer, so the token never follows it


class UrllibHttp:
    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_NoRedirect)

    def get(self, url: str, headers: dict[str, str], limit: int) -> Answer:
        req = urllib.request.Request(url, headers={**headers, "User-Agent": f"housebook/{__version__}"})
        try:
            with self._opener.open(req, timeout=TIMEOUT) as res:
                return Answer(res.status, res.headers.get("Content-Type", ""), _read(res, limit))
        except urllib.error.HTTPError as e:
            return Answer(e.code, e.headers.get("Content-Type", "") if e.headers else "", b"")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise PaperlessError(f"can't reach Paperless: {getattr(e, 'reason', e)}") from None


def _read(res: Any, limit: int) -> bytes:
    length = res.headers.get("Content-Length")
    if length and length.isdigit() and int(length) > limit:
        raise TooLarge(f"answer larger than {limit // (1024 * 1024)} MiB")
    body = res.read(limit + 1)
    if len(body) > limit:
        raise TooLarge(f"answer larger than {limit // (1024 * 1024)} MiB")
    return body


@dataclass(frozen=True)
class Document:
    id: int
    title: str
    created: str | None  # YYYY-MM-DD
    file_name: str | None
    url: str  # the document's page, for people (the public address)


@dataclass(frozen=True)
class File:
    content_type: str
    body: bytes


class Paperless:
    def __init__(self, settings: Settings, http: Http | None = None, clock: Callable[[], float] = time.monotonic):
        assert settings.paperless_url and settings.paperless_token and settings.paperless_public_url
        self.api = f"{settings.paperless_url}/api"
        self.public_url = settings.paperless_public_url
        self.bases = tuple(dict.fromkeys((settings.paperless_public_url, settings.paperless_url)))
        self._token = settings.paperless_token
        self.http: Http = http or UrllibHttp()
        self.clock = clock
        self._lock = threading.Lock()
        self._docs: dict[int, tuple[float, Document | None]] = {}
        self._missing: frozenset[int] = frozenset()

    # --- calls ---------------------------------------------------------------------------

    def _get(self, path: str, params: dict[str, str] | None = None, limit: int = MAX_JSON) -> Answer:
        url = f"{self.api}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        headers = {"Authorization": f"Token {self._token}", "Accept": "application/json"}
        return self.http.get(url, headers, limit)

    def _json(self, answer: Answer, what: str) -> Any:
        if answer.status in (401, 403):
            raise PaperlessError(f"Paperless refused the token ({answer.status}) for {what}")
        if answer.status != 200:
            raise PaperlessError(f"Paperless answered {answer.status} for {what}")
        try:
            return json.loads(answer.body)
        except ValueError:
            raise PaperlessError(f"Paperless didn't answer JSON for {what}") from None

    def _doc(self, raw: Any) -> Document:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), int):
            raise PaperlessError("Paperless answered a document without an id")
        created = raw.get("created")
        file_name = raw.get("original_file_name")
        return Document(
            id=raw["id"],
            title=str(raw.get("title") or f"Document {raw['id']}"),
            created=str(created)[:10] if created else None,
            file_name=str(file_name) if file_name else None,
            url=document_url(self.public_url, raw["id"]),
        )

    def search(self, query: str) -> list[Document]:
        """Full-text search, best matches first; the newest documents for an empty query."""
        params = {"page_size": str(SEARCH_SIZE), "fields": FIELDS}
        if query.strip():
            params["query"] = query.strip()
        else:
            params["ordering"] = "-created"
        data = self._json(self._get("/documents/", params), "a search")
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list):
            raise PaperlessError("Paperless answered a search without results")
        docs = [self._doc(r) for r in results]
        now = self.clock()
        with self._lock:
            for d in docs:
                self._docs[d.id] = (now, d)
        return docs

    def document(self, doc_id: int, *, fresh: bool = False) -> Document | None:
        """A document's title and date; None when Paperless says it doesn't exist (deleted, or the
        token's user can't see it). Remembered for DOC_TTL."""
        now = self.clock()
        with self._lock:
            cached = self._docs.get(doc_id)
        if cached and not fresh and now - cached[0] < DOC_TTL:
            return cached[1]
        answer = self._get(f"/documents/{doc_id}/", {"fields": FIELDS})
        doc = None if answer.status == 404 else self._doc(self._json(answer, f"document {doc_id}"))
        with self._lock:
            self._docs[doc_id] = (now, doc)
        return doc

    def file(self, doc_id: int, kind: str) -> File | None:
        """The thumbnail (`thumb`) or the PDF/image to view (`preview`); None when it doesn't exist."""
        assert kind in ("thumb", "preview")
        answer = self._get(f"/documents/{doc_id}/{kind}/", limit=MAX_FILE)
        if answer.status == 404:
            return None
        if answer.status in (401, 403):
            raise PaperlessError(f"Paperless refused the token ({answer.status}) for document {doc_id}")
        if answer.status != 200:
            raise PaperlessError(f"Paperless answered {answer.status} for document {doc_id}")
        return File(answer.content_type.split(";")[0].strip().lower(), answer.body)

    # --- missing documents (the `paperless_missing` problem) ----------------------------

    @property
    def missing(self) -> frozenset[int]:
        return self._missing

    def note(self, doc_id: int, doc: Document | None) -> bool:
        """Record what Paperless said about a linked document; True when the missing set changed."""
        with self._lock:
            before = self._missing
            self._missing = before | {doc_id} if doc is None else before - {doc_id}
            return self._missing != before

    def check(self, doc_ids: Iterable[int]) -> bool:
        """Ask Paperless about every linked document. Stops at the first failure (Paperless is
        down: nothing is known, so nothing changes). True when the missing set changed."""
        ids = set(doc_ids)
        changed = False
        for doc_id in sorted(ids):
            changed |= self.note(doc_id, self.document(doc_id, fresh=True))
        with self._lock:  # forget documents no note links any more
            kept = self._missing & ids
            changed |= kept != self._missing
            self._missing = kept
        return changed
