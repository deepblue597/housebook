"""Receipts in Paperless-ngx (milestone 11, D52, data contract §3.7 and §8.4)."""

import http.server
import json
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from conftest import ClientFactory, make_settings
from housebook.config import ConfigError, Settings
from housebook.domain.item import parse_fields
from housebook.domain.receipts import document_id, document_url
from housebook.services.paperless import Answer, Paperless, PaperlessError, TooLarge, UrllibHttp

INTERNAL = "http://paperless:8000"
PUBLIC = "https://paperless.example"
TOKEN = "s3cr3t-token"
PDF = b"%PDF-1.7\n" + b"x" * 100
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"x" * 20


@dataclass
class FakePaperless:
    """Paperless-ngx's API, as far as Housebook uses it."""

    docs: dict[int, dict] = field(
        default_factory=lambda: {
            12: {"id": 12, "title": "Dishwasher invoice", "created": "2024-05-10", "original_file_name": "inv.pdf"},
            13: {"id": 13, "title": "Fridge receipt", "created": "2023-02-01T00:00:00+02:00"},
        }
    )
    down: bool = False
    calls: list[str] = field(default_factory=list)
    previews: dict[int, bytes] = field(default_factory=dict)

    def get(self, url: str, headers: dict[str, str], limit: int) -> Answer:
        assert headers["Authorization"] == f"Token {TOKEN}"
        assert url.startswith(f"{INTERNAL}/api/"), url  # never the public address, never elsewhere
        self.calls.append(url)
        if self.down:
            raise PaperlessError("can't reach Paperless: connection refused")
        parts = urlsplit(url)
        path, query = parts.path.removeprefix("/api"), parse_qs(parts.query)
        if path == "/documents/":
            docs = sorted(self.docs.values(), key=lambda d: -d["id"])
            if "query" in query:
                words = query["query"][0].lower().split()
                docs = [d for d in docs if all(w in d["title"].lower() for w in words)]
            return Answer(200, "application/json", json.dumps({"count": len(docs), "results": docs}).encode())
        segments = path.strip("/").split("/")
        doc = self.docs.get(int(segments[1]))
        if doc is None:
            return Answer(404, "application/json", b'{"detail":"No Document matches the given query."}')
        if len(segments) == 2:
            return Answer(200, "application/json", json.dumps(doc).encode())
        if segments[2] == "thumb":
            return Answer(200, "image/webp", WEBP)
        return Answer(200, "application/pdf", self.previews.get(doc["id"], PDF))


def link_receipts(root: Path, *links: str) -> None:
    note = root / "House" / "Kitchen" / "Dishwasher.md"
    text = note.read_text()
    note.write_text(text.replace("tags: [housebook]", f"receipts: {json.dumps(list(links))}\ntags: [housebook]"))


@pytest.fixture
def fake() -> FakePaperless:
    return FakePaperless()


@pytest.fixture
def connect(make_client: ClientFactory, fake: FakePaperless):
    def factory(root: Path, **overrides: object) -> TestClient:
        c = make_client(
            root,
            paperless_url=INTERNAL,
            paperless_public_url=PUBLIC,
            paperless_token=TOKEN,
            **{"anon_role": "editor", **overrides},
        )
        c.app.state.ctx.paperless.http = fake  # type: ignore[attr-defined]
        return c

    return factory


# --- settings -----------------------------------------------------------------------------


def test_settings(tmp_path: Path):
    s = Settings.from_env({"HOUSEBOOK_PAPERLESS_URL": "http://paperless:8000/", "HOUSEBOOK_PAPERLESS_TOKEN": "t"})
    assert (s.paperless_url, s.paperless_public_url, s.paperless_token) == ("http://paperless:8000",) * 2 + ("t",)
    secret = tmp_path / "token"
    secret.write_text("from-a-file\n")
    s = Settings.from_env(
        {
            "HOUSEBOOK_PAPERLESS_URL": "http://paperless:8000",
            "HOUSEBOOK_PAPERLESS_PUBLIC_URL": "https://example.org/paperless/",
            "HOUSEBOOK_PAPERLESS_TOKEN_FILE": str(secret),
        }
    )
    assert (s.paperless_public_url, s.paperless_token) == ("https://example.org/paperless", "from-a-file")
    assert Settings.from_env({}).paperless_url is None


@pytest.mark.parametrize(
    "env, message",
    [
        ({"HOUSEBOOK_PAPERLESS_URL": "http://paperless:8000"}, "needs HOUSEBOOK_PAPERLESS_TOKEN"),
        ({"HOUSEBOOK_PAPERLESS_TOKEN": "t"}, "need HOUSEBOOK_PAPERLESS_URL"),
        ({"HOUSEBOOK_PAPERLESS_URL": "paperless:8000", "HOUSEBOOK_PAPERLESS_TOKEN": "t"}, "http"),
        ({"HOUSEBOOK_PAPERLESS_URL": "https://p.example/?a=1", "HOUSEBOOK_PAPERLESS_TOKEN": "t"}, "http"),
    ],
)
def test_bad_settings(env: dict[str, str], message: str):
    with pytest.raises(ConfigError, match=message):
        Settings.from_env(env)


# --- links in notes -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "link, expected",
    [
        (f"{PUBLIC}/documents/1234/details", 1234),
        (f"{PUBLIC}/documents/1234", 1234),
        (f"{PUBLIC}/documents/1234/", 1234),
        (f"{PUBLIC}/documents/1234/details?x=1#notes", 1234),
        ("HTTPS://Paperless.Example/documents/7/details", 7),
        (f"{INTERNAL}/documents/9/details", 9),
        ("https://example.org/paperless/documents/5/details", 5),
        ("https://example.org/documents/5/details", None),  # not under the path
        ("http://paperless.example/documents/5/details", None),  # another scheme
        ("https://other.example/documents/5/details", None),
        (f"{PUBLIC}/documents/0/details", None),
        (f"{PUBLIC}/documents/abc/details", None),
        (f"{PUBLIC}/documents/", None),
        (f"{PUBLIC}/api/documents/5/", None),
        ("not a link", None),
        ("https://[bad", None),
    ],
)
def test_document_id(link: str, expected: int | None):
    assert document_id(link, (PUBLIC, INTERNAL, "https://example.org/paperless")) == expected


def test_document_url():
    assert document_url(PUBLIC, 12) == f"{PUBLIC}/documents/12/details"
    assert document_id(document_url("https://example.org/paperless", 12), ("https://example.org/paperless",)) == 12


def test_receipts_field():
    fields, errors = parse_fields({"receipts": [f"{PUBLIC}/documents/12/details", "https://shop.example/r/1"]})
    assert fields.receipts == [f"{PUBLIC}/documents/12/details", "https://shop.example/r/1"] and not errors
    fields, errors = parse_fields({"receipts": f"{PUBLIC}/documents/12/details"})
    assert fields.receipts == [f"{PUBLIC}/documents/12/details"]
    fields, errors = parse_fields({"receipts": ["javascript:alert(1)"]})
    assert fields.receipts == [] and errors[0].key == "receipts"


# --- API ----------------------------------------------------------------------------------


def test_not_set_up(example_root: Path, make_client: ClientFactory):
    link_receipts(example_root, f"{PUBLIC}/documents/12/details")
    c = make_client(example_root, anon_role="editor")
    assert c.get("/api/snapshot").json()["paperlessUrl"] is None
    assert c.get("/api/items/it_7f3k2a/receipts").json() == {
        "receipts": [
            {
                "url": f"{PUBLIC}/documents/12/details",
                "documentId": None,
                "state": "link",
                "title": None,
                "created": None,
                "thumbUrl": None,
                "previewUrl": None,
            }
        ]
    }
    assert c.get("/api/paperless/search").status_code == 404
    assert c.get("/api/items/it_7f3k2a/receipts/12/preview").status_code == 404
    item = c.get("/api/items/it_7f3k2a").json()
    assert item["fields"]["receipts"] == [f"{PUBLIC}/documents/12/details"]


def test_search(example_root: Path, connect, fake: FakePaperless):
    c = connect(example_root)
    assert c.get("/api/snapshot").json()["paperlessUrl"] == PUBLIC
    r = c.get("/api/paperless/search", params={"q": "invoice"})
    assert r.status_code == 200
    assert r.json() == {
        "results": [
            {
                "documentId": 12,
                "title": "Dishwasher invoice",
                "created": "2024-05-10",
                "url": f"{PUBLIC}/documents/12/details",
                "thumbUrl": "/api/paperless/documents/12/thumb",
            }
        ]
    }
    newest = c.get("/api/paperless/search").json()["results"]
    assert [d["documentId"] for d in newest] == [13, 12] and newest[0]["created"] == "2023-02-01"
    assert "ordering=-created" in fake.calls[-1] and "page_size=24" in fake.calls[-1]
    thumb = c.get("/api/paperless/documents/13/thumb")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    fake.down = True
    r = c.get("/api/paperless/search", params={"q": "x"})
    assert r.status_code == 502 and "can't reach Paperless" in r.json()["detail"] and TOKEN not in r.text


def test_search_is_for_editors(example_root: Path, connect, fake: FakePaperless):
    c = connect(example_root, anon_role="viewer")
    assert c.get("/api/paperless/search", params={"q": "invoice"}).status_code == 403
    assert c.get("/api/paperless/documents/12/thumb").status_code == 403
    assert fake.calls == []


def test_receipts_of_an_item(example_root: Path, connect, fake: FakePaperless):
    link_receipts(
        example_root,
        f"{PUBLIC}/documents/12/details",
        "https://shop.example/order/77",
        f"{PUBLIC}/documents/99/details",
    )
    c = connect(example_root, anon_role="viewer")  # viewers see receipts like attachments
    got = c.get("/api/items/it_7f3k2a/receipts").json()["receipts"]
    assert [(r["documentId"], r["state"], r["title"]) for r in got] == [
        (12, "found", "Dishwasher invoice"),
        (None, "link", None),
        (99, "missing", None),
    ]
    assert got[0]["created"] == "2024-05-10"
    assert got[0]["thumbUrl"] == "/api/items/it_7f3k2a/receipts/12/thumb"
    assert got[0]["previewUrl"] == "/api/items/it_7f3k2a/receipts/12/preview"
    # The missing one is now a problem too.
    problems = [p for p in c.get("/api/problems").json()["problems"] if p["kind"] == "paperless_missing"]
    assert problems == [
        {
            "kind": "paperless_missing",
            "severity": "warning",
            "message": f"Receipt {PUBLIC}/documents/99/details isn't in Paperless any more (deleted, or "
            "Housebook's Paperless user can't see it)",
            "path": "House/Kitchen/Dishwasher.md",
            "itemId": "it_7f3k2a",
            "detail": {"url": f"{PUBLIC}/documents/99/details"},
        }
    ]
    # Remembered for a while: a second look doesn't ask Paperless again.
    calls = len(fake.calls)
    c.get("/api/items/it_7f3k2a/receipts")
    assert len(fake.calls) == calls


def test_receipts_when_paperless_is_down(example_root: Path, connect, fake: FakePaperless):
    link_receipts(example_root, f"{PUBLIC}/documents/12/details", f"{PUBLIC}/documents/13/details")
    fake.down = True
    c = connect(example_root)
    got = c.get("/api/items/it_7f3k2a/receipts").json()["receipts"]
    assert [(r["documentId"], r["state"]) for r in got] == [(12, "unreachable"), (13, "unreachable")]
    assert len(fake.calls) == 1  # gave up after the first failure instead of waiting on each
    assert not [p for p in c.get("/api/problems").json()["problems"] if p["kind"] == "paperless_missing"]
    assert c.get("/api/items/it_7f3k2a/receipts/12/preview").status_code == 502


def test_receipt_files(example_root: Path, connect, fake: FakePaperless):
    link_receipts(example_root, f"{PUBLIC}/documents/12/details", f"{PUBLIC}/documents/13/details")
    fake.previews[13] = b"<html><script>alert(1)</script>"
    c = connect(example_root, anon_role="viewer")
    r = c.get("/api/items/it_7f3k2a/receipts/12/preview")
    assert r.status_code == 200 and r.content == PDF
    assert r.headers["content-type"] == "application/pdf" and r.headers["content-disposition"] == "inline"
    assert r.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert r.headers["x-content-type-options"] == "nosniff"
    r = c.get("/api/items/it_7f3k2a/receipts/12/thumb")
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    # Not a PDF or an image we know: a download, never rendered.
    r = c.get("/api/items/it_7f3k2a/receipts/13/preview")
    assert r.headers["content-type"] == "application/octet-stream"
    assert r.headers["content-disposition"].startswith("attachment")


def test_only_linked_documents_are_served(example_root: Path, connect, fake: FakePaperless):
    link_receipts(example_root, f"{PUBLIC}/documents/12/details")
    c = connect(example_root)
    assert c.get("/api/items/it_7f3k2a/receipts/13/preview").status_code == 404
    assert c.get("/api/items/it_7f3k2a/receipts/13/thumb").status_code == 404
    assert c.get("/api/items/it_unknown/receipts/12/thumb").status_code == 404
    assert c.get("/api/items/it_7f3k2a/receipts/12/download").status_code == 422
    assert c.get("/api/items/it_7f3k2a/receipts/abc/thumb").status_code == 422
    assert not [u for u in fake.calls if "/13/" in u]


def test_link_a_receipt_with_a_patch(example_root: Path, connect):
    c = connect(example_root)
    found = c.get("/api/paperless/search", params={"q": "dishwasher"}).json()["results"][0]
    etag = c.get("/api/items/it_7f3k2a").headers["etag"]
    r = c.patch(
        "/api/items/it_7f3k2a",
        json={"frontmatter": {"receipts": [found["url"]]}},
        headers={"If-Match": etag, "Content-Type": "application/merge-patch+json"},
    )
    assert r.status_code == 200 and r.json()["fields"]["receipts"] == [f"{PUBLIC}/documents/12/details"]
    note = (example_root / "House" / "Kitchen" / "Dishwasher.md").read_text()
    assert "receipts:" in note and f"{PUBLIC}/documents/12/details" in note


# --- the hourly check ---------------------------------------------------------------------


def test_check_reports_and_clears_missing_documents(example_root: Path, connect, fake: FakePaperless):
    link_receipts(example_root, f"{PUBLIC}/documents/12/details")
    c = connect(example_root)
    ctx = c.app.state.ctx  # type: ignore[attr-defined]

    def missing() -> list[str]:
        ctx.indexer.scan()
        return [p.detail["url"] for p in ctx.indexer.state.problems if p.kind == "paperless_missing"]

    assert ctx.paperless.check({12}) is False and missing() == []
    del fake.docs[12]
    assert ctx.paperless.check({12}) is True and missing() == [f"{PUBLIC}/documents/12/details"]
    fake.down = True  # down: nothing is known, nothing changes
    with pytest.raises(PaperlessError):
        ctx.paperless.check({12})
    assert missing() == [f"{PUBLIC}/documents/12/details"]
    fake.down = False
    fake.docs[12] = {"id": 12, "title": "Back again"}
    assert ctx.paperless.check({12}) is True and missing() == []
    del fake.docs[12]
    ctx.paperless.check({12})
    assert ctx.paperless.check(set()) is True and ctx.paperless.missing == frozenset()  # unlinked: forgotten


# --- the HTTP client ----------------------------------------------------------------------


@pytest.fixture
def server() -> Iterator[tuple[str, list[dict]]]:
    """A real HTTP server: /redirect points elsewhere, /big is larger than the limit."""
    seen: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.append({"path": self.path, "authorization": self.headers.get("Authorization")})
            if self.path.startswith("/redirect"):
                self.send_response(302)
                self.send_header("Location", "/elsewhere")
                self.end_headers()
                return
            body = b"x" * (2000 if self.path.startswith("/big") else 10)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            if not self.path.startswith("/big-unknown"):
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", seen
    httpd.shutdown()


def test_redirects_are_not_followed(server: tuple[str, list[dict]]):
    url, seen = server
    answer = UrllibHttp().get(f"{url}/redirect", {"Authorization": f"Token {TOKEN}"}, 1000)
    assert answer.status == 302
    assert [s["path"] for s in seen] == ["/redirect"]  # the token never went to /elsewhere


def test_answers_are_size_limited(server: tuple[str, list[dict]]):
    url, _ = server
    for path in ("/big", "/big-unknown"):  # with and without Content-Length
        with pytest.raises(TooLarge):
            UrllibHttp().get(f"{url}{path}", {}, 1000)
    assert UrllibHttp().get(f"{url}/small", {}, 1000).body == b"x" * 10


def test_unreachable(tmp_path: Path):
    s = make_settings(tmp_path, paperless_url="http://127.0.0.1:9", paperless_public_url=PUBLIC, paperless_token=TOKEN)
    with pytest.raises(PaperlessError, match="can't reach Paperless") as e:
        Paperless(s).search("x")
    assert TOKEN not in str(e.value)
