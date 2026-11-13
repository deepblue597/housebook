"""Black-box tests against a real `housebook serve` process (uvicorn, one worker)."""

import contextlib
import gzip
import json
import socket
import statistics
import time
from datetime import date
from pathlib import Path

import httpx2 as httpx
import pytest

import nasty_vault
import vault_builders as vb

from .conftest import Server, ServerFactory, stop


def raw_get(server: Server, target: str) -> tuple[int, bytes]:
    """Send a request line exactly as given (no client-side normalisation of `..` etc.)."""
    host, port = server.base.removeprefix("http://").split(":")
    with socket.create_connection((host, int(port)), timeout=10) as s:
        s.sendall(f"GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode("latin-1"))
        data = b""
        while chunk := s.recv(65536):
            data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    return int(head.split(b" ")[1]), body


def wait_for(cond, timeout: float = 8.0, step: float = 0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if v := cond():
            return v
        time.sleep(step)
    raise AssertionError("condition not met in time")


# --- endpoints ---------------------------------------------------------------------------


def test_every_endpoint_on_the_example(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples)
    assert s.get("/healthz").json() == {"status": "ok", "checks": {}}
    assert s.get("/readyz").json() == {"status": "ready", "checks": {"scanned": True, "dataWritable": True}}

    house = s.get("/api/house")
    assert house.status_code == 200 and house.headers["etag"] and house.json()["schemaVersion"] == 1

    snap = s.get("/api/snapshot")
    body = snap.json()
    assert set(body) == {
        "today",
        "timezone",
        "house",
        "houseEtag",
        "houseReadOnly",
        "houseSchemaVersion",
        "itemsVersion",
        "items",
        "problemCount",
    }
    assert body["timezone"] == "Europe/Athens" and len(body["items"]) == 14 and body["problemCount"] == 0
    assert f'"{body["houseEtag"]}"' == house.headers["etag"]

    items = s.get("/api/items").json()
    assert items["count"] == 14 and all("body" not in i for i in items["items"])
    for it in body["items"]:
        detail = s.get(f"/api/items/{it['id']}")
        assert detail.status_code == 200 and detail.json() == it, it["id"]
        assert detail.headers["etag"] == f'"{it["etag"]}"'
        for att in it["attachments"]:
            r = s.get(att["url"])
            assert r.status_code == 200 and len(r.content) == att["size"]
            assert r.headers["x-content-type-options"] == "nosniff"

    assert s.get("/api/problems").json()["count"] == 0
    cat = s.get("/api/catalog").json()
    assert {"boiler", "gas_valve", "fridge"} <= {t["key"] for t in cat["types"]}
    assert s.get("/api/me").json() == {
        "user": None,
        "name": None,
        "role": "viewer",
        "authMode": "none",
        "logoutUrl": None,
    }
    assert s.get("/api/openapi.json").status_code == 200 and s.get("/api/docs").status_code == 200

    for path in ["/api/items/nope", "/api/items/it_7f3k2a/attachments/nope.pdf", "/api/nope", "/nope"]:
        r = s.get(path)
        assert r.status_code == 404 and r.headers["content-type"] == "application/json", path
    assert s.get("/").json()["web"] == "not built"
    assert "server" not in s.get("/healthz").headers  # server_header=False


def test_conditional_get_and_rescan_picks_up_edits(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, HOUSEBOOK_RESCAN_INTERVAL="1")
    h1, s1 = s.get("/api/house").headers["etag"], s.get("/api/snapshot").headers["etag"]
    assert s.get("/api/house", headers={"If-None-Match": h1}).status_code == 304
    r = s.get("/api/snapshot", headers={"If-None-Match": s1})
    assert r.status_code == 304 and r.content == b"" and r.headers["etag"] == s1

    note = copy_examples / "House/Kitchen/Dishwasher.md"
    note.write_text(note.read_text() + "\n- 2026-11-01 Black-box test entry\n")
    s2 = wait_for(lambda: (e := s.get("/api/snapshot").headers["etag"]) != s1 and e)
    assert s.get("/api/house").headers["etag"] == h1  # notes don't touch the layout
    assert s.get("/api/snapshot", headers={"If-None-Match": s1}).status_code == 200

    data = json.loads((copy_examples / "house.json").read_text())
    data["rooms"][0]["name"] = "Lounge"
    (copy_examples / "house.json").write_text(json.dumps(data, indent=2))
    wait_for(lambda: s.get("/api/house").headers["etag"] != h1)
    assert s.get("/api/snapshot").headers["etag"] != s2
    assert s.get("/api/house", headers={"If-None-Match": h1}).status_code == 200


def test_rescan_keeps_last_good_note_and_house(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, HOUSEBOOK_RESCAN_INTERVAL="1")
    (copy_examples / "House/Kitchen/Fridge.md").write_text("---\nhousebook_id: it_4f8k2q\nname: [half-writ")
    (copy_examples / "house.json").write_text('{"schemaVersion": 1, "grid": ')
    probs = wait_for(lambda: (p := s.get("/api/problems").json())["count"] >= 2 and p)
    kinds = {(p["kind"], p["path"]) for p in probs["problems"]}
    assert {("note_parse_error", "House/Kitchen/Fridge.md"), ("house_invalid", "house.json")} <= kinds
    fridge = s.get("/api/items/it_4f8k2q").json()
    assert fridge["stale"] is True and fridge["name"] == "Fridge"
    assert s.get("/api/house").status_code == 200  # last valid layout still served
    assert not any(p["kind"] == "missing_note" for p in probs["problems"])


# --- messy data -------------------------------------------------------------------------


def test_nasty_vault_never_500s(tmp_path: Path, serve: ServerFactory):
    root = tmp_path / "vault"
    nasty_vault.build(root, tmp_path / "outside")
    vb.item(root, "it_bomb2", "name: small alias\n" + vb.alias_bomb(levels=2))
    s = serve(root)
    snap = s.get("/api/snapshot").json()
    for it in snap["items"]:
        assert s.get(f"/api/items/{it['id']}").status_code == 200
        for att in it["attachments"]:
            assert s.get(att["url"]).status_code == 200, att
    kinds = {p["kind"] for p in s.get("/api/problems").json()["problems"]}
    assert {
        "note_parse_error",
        "note_invalid_id",
        "note_invalid_field",
        "duplicate_id",
        "conflict_copy",
        "unknown_type",
        "missing_note",
        "attachment_missing",
        "attachment_unsafe",
        "symlink_outside_root",
        "not_adopted",
        "untagged_typed",
        "house_bad_cell",
        "house_unknown_room",
        "house_outside_grid",
        "house_duplicate_placement",
    } <= kinds
    serial = s.get("/api/items/it_serial").json()["fields"]
    assert (serial["serial"], serial["model"]) == ("0123", "no")
    assert s.get("/api/items/it_evil00").status_code == 404  # symlinked note outside the root
    for q in ["ψυγειο", "ΨΥΓΕΊΟ", "Ψυγείο"]:
        assert [i["id"] for i in s.get("/api/items", params={"q": q}).json()["items"]] == ["it_greek"], q


# --- time zone --------------------------------------------------------------------------


def test_housebook_tz_decides_today(copy_examples: Path, serve: ServerFactory):
    east = serve(copy_examples, HOUSEBOOK_TZ="Pacific/Kiritimati")  # UTC+14
    east_today = date.fromisoformat(east.get("/api/snapshot").json()["today"])
    east_days = east.get("/api/items/it_7f3k2a").json()["status"]["warranty"]["days"]
    stop(east)
    west = serve(copy_examples, HOUSEBOOK_TZ="Etc/GMT+12")  # UTC-12
    west_today = date.fromisoformat(west.get("/api/snapshot").json()["today"])
    west_days = west.get("/api/items/it_7f3k2a").json()["status"]["warranty"]["days"]
    assert (east_today - west_today).days in (1, 2)
    assert west_days - east_days == (east_today - west_today).days


# --- security ---------------------------------------------------------------------------


@pytest.fixture
def spa(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Housebook SPA</title>")
    (web / "sw.js").write_text("// sw")
    (web / "assets/index-B4x9KqZ1.js").write_text("console.log(1)")
    return web


TRAVERSALS = [
    "/../../../../etc/passwd",
    "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/..%2f..%2f..%2fetc%2fpasswd",
    "/..%5c..%5c..%5cetc%5cpasswd",
    "/assets/../../../../etc/passwd",
    "//etc/passwd",
    "/%2fetc%2fpasswd",
    "/etc/passwd%00.js",
    "/api/items/it_7f3k2a/attachments/../../../../../etc/passwd",
    "/api/items/it_7f3k2a/attachments/%2e%2e%2f%2e%2e%2f%2e%2e%2fhouse.json",
    "/api/items/it_7f3k2a/attachments/..%5c..%5chouse.json",
    "/api/items/it_7f3k2a/attachments/%2fetc%2fpasswd",
    "/api/items/it_7f3k2a/attachments/manual.pdf%00.png",
    "/api/items/it_7f3k2a/attachments/%00",
    "/api/items/..%2f..%2fhouse.json/attachments/x",
    "/api/items/it_7f3k2a/attachments/C:%5cWindows%5cwin.ini",
]


@pytest.mark.parametrize("target", TRAVERSALS)
def test_path_traversal_raw_requests(copy_examples: Path, serve: ServerFactory, spa: Path, target: str, tmp_path):
    (tmp_path / "secret.txt").write_text("TOP-SECRET")
    s = serve(copy_examples, HOUSEBOOK_STATIC_DIR=str(spa))
    status, body = raw_get(s, target)
    assert status < 500, (target, status)
    assert b"root:" not in body and b"TOP-SECRET" not in body and b"schemaVersion" not in body, target


def test_symlinks_out_of_the_root(copy_examples: Path, serve: ServerFactory, tmp_path: Path):
    out = tmp_path / "outside"
    out.mkdir()
    (out / "secret.pdf").write_bytes(b"%PDF-1.4 TOP-SECRET")
    (out / "Secret.md").write_text(vb.note("housebook_id: it_secret\nname: Secret"))
    (copy_examples / "House/Kitchen/Dishwasher/leak.pdf").symlink_to(out / "secret.pdf")
    (copy_examples / "House/Kitchen/Leak.md").symlink_to(out / "Secret.md")
    (copy_examples / "House/Linked").symlink_to(out, target_is_directory=True)
    s = serve(copy_examples)
    assert s.get("/api/items/it_secret").status_code == 404
    assert s.get("/api/items/it_7f3k2a/attachments/leak.pdf").status_code == 404
    assert b"TOP-SECRET" not in s.get("/api/snapshot").content
    outside = {p["path"] for p in s.get("/api/problems").json()["problems"] if p["kind"] == "symlink_outside_root"}
    assert outside == {"House/Kitchen/Dishwasher/leak.pdf", "House/Kitchen/Leak.md", "House/Linked"}


def test_attachment_headers_and_ranges(copy_examples: Path, serve: ServerFactory):
    d = copy_examples / "House/Kitchen/Dishwasher"
    (d / "evil.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    (d / "evil.html").write_text("<script>alert(1)</script>")
    s = serve(copy_examples)
    base = "/api/items/it_7f3k2a/attachments/"
    pdf = s.get(base + "manual.pdf")
    assert pdf.headers["content-type"] == "application/pdf" and pdf.headers["accept-ranges"] == "bytes"
    assert pdf.headers["content-disposition"].startswith("inline")
    assert pdf.headers["x-content-type-options"] == "nosniff"
    size = len(pdf.content)
    part = s.get(base + "manual.pdf", headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == pdf.content[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{size}"
    tail = s.get(base + "manual.pdf", headers={"Range": "bytes=-5"})
    assert tail.status_code == 206 and tail.content == pdf.content[-5:]
    assert s.get(base + "manual.pdf", headers={"Range": f"bytes={size}-"}).status_code == 416
    png = s.get(base + "receipt.png")
    assert png.headers["content-type"] == "image/png"
    assert png.headers["content-security-policy"] == "default-src 'none'; sandbox"
    for name in ["evil.svg", "evil.html"]:
        r = s.get(base + name)
        assert r.headers["content-type"] == "application/octet-stream", name
        assert r.headers["content-disposition"].startswith("attachment"), name
        assert r.headers["content-security-policy"] == "default-src 'none'; sandbox", name


def test_spa_fallback_and_cache_headers(copy_examples: Path, serve: ServerFactory, spa: Path):
    s = serve(copy_examples, HOUSEBOOK_STATIC_DIR=str(spa))
    for path in ["/", "/i/it_7f3k2a", "/print/emergency", "/some/deep/route"]:
        r = s.get(path)
        assert r.status_code == 200 and "Housebook SPA" in r.text and r.headers["cache-control"] == "no-cache", path
    assert s.get("/assets/index-B4x9KqZ1.js").headers["cache-control"] == "public, max-age=31536000, immutable"
    assert s.get("/sw.js").headers["cache-control"] == "no-cache"
    assert s.get("/assets/index-Gone1234.js").status_code == 404
    assert s.get("/api/unknown").status_code == 404
    assert s.get("/api/snapshot").headers["cache-control"] == "no-cache"


def test_head_on_health(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples)
    assert httpx.head(s.base + "/readyz").status_code == 200


# --- auth -------------------------------------------------------------------------------


def _client_from(source_ip: str) -> httpx.Client:
    return httpx.Client(transport=httpx.HTTPTransport(local_address=source_ip), timeout=10)


def test_proxy_auth_trusts_only_configured_peers(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, HOUSEBOOK_AUTH_MODE="proxy", HOUSEBOOK_TRUSTED_PROXIES="127.0.0.2/32")
    editor = {"X-Forwarded-User": "iasonas", "X-Forwarded-Groups": "/family,/housebook-editors"}
    with _client_from("127.0.0.2") as proxy, _client_from("127.0.0.3") as other:
        assert proxy.get(s.base + "/api/me", headers=editor).json() == {
            "user": "iasonas",
            "name": "iasonas",
            "role": "editor",
            "authMode": "proxy",
            "logoutUrl": "/oauth2/sign_out",
        }
        viewer = {"X-Forwarded-User": "kid", "X-Forwarded-Groups": "/family"}
        assert proxy.get(s.base + "/api/me", headers=viewer).json()["role"] == "viewer"
        assert proxy.get(s.base + "/api/me").status_code == 401
        spoof = {**editor, "X-Forwarded-For": "127.0.0.2", "Forwarded": "for=127.0.0.2"}
        for path in ["/api/me", "/api/snapshot", "/api/house", "/api/items/it_7f3k2a/attachments/manual.pdf"]:
            assert other.get(s.base + path, headers=spoof).status_code == 401, path
        assert other.get(s.base + "/healthz").status_code == 200
        assert other.get(s.base + "/readyz").status_code == 200


def test_proxy_mode_without_trusted_proxies_refuses_to_start(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, wait=False, HOUSEBOOK_AUTH_MODE="proxy")
    assert s.proc.wait(20) == 2
    assert "HOUSEBOOK_TRUSTED_PROXIES" in s.logs()


def test_anon_editor_only_when_explicit(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, HOUSEBOOK_ANON_ROLE="editor")
    assert s.get("/api/me").json()["role"] == "editor"


# --- ops --------------------------------------------------------------------------------


def test_second_instance_on_same_data_root_exits(copy_examples: Path, serve: ServerFactory):
    first = serve(copy_examples)
    second = serve(copy_examples, wait=False)
    assert second.proc.wait(20) != 0
    assert "lock" in second.logs().lower()
    assert first.get("/readyz").status_code == 200


def test_read_only_data_root_serves_but_not_ready(copy_examples: Path, serve: ServerFactory):
    (copy_examples / ".housebook").mkdir(exist_ok=True)
    paths = [copy_examples, copy_examples / ".housebook"]
    for p in paths:
        p.chmod(0o555)
    try:
        s = serve(copy_examples)
        assert s.get("/readyz").status_code == 503
        assert s.get("/api/snapshot").status_code == 200
    finally:
        for p in paths:
            p.chmod(0o755)


def test_performance_500_notes(tmp_path: Path, serve: ServerFactory, record_property):
    root = tmp_path / "bulk"
    vb.build_bulk(root, n=500)
    s = serve(root)
    snap = s.get("/api/snapshot")
    assert snap.status_code == 200 and len(snap.json()["items"]) == 500
    times = []
    for _ in range(20):
        t = time.perf_counter()
        s.get("/api/snapshot")
        times.append((time.perf_counter() - t) * 1000)
    cond = []
    for _ in range(20):
        t = time.perf_counter()
        assert s.get("/api/snapshot", headers={"If-None-Match": snap.headers["etag"]}).status_code == 304
        cond.append((time.perf_counter() - t) * 1000)
    t = time.perf_counter()
    s.get("/api/items", params={"q": "ψυγειο e7"})
    search_ms = (time.perf_counter() - t) * 1000
    scan_ms = next(json.loads(line)["ms"] for line in s.logs().splitlines() if '"scan done"' in line)
    gz = httpx.get(s.base + "/api/snapshot", headers={"Accept-Encoding": "gzip"})
    stats = {
        "startup_s": round(s.startup_s, 2),
        "scan_ms": scan_ms,
        "snapshot_bytes": len(snap.content),
        "snapshot_gzip_bytes_if_compressed": len(gzip.compress(snap.content)),
        "served_content_encoding": gz.headers.get("content-encoding"),
        "snapshot_p50_ms": round(statistics.median(times), 1),
        "snapshot_max_ms": round(max(times), 1),
        "snapshot_304_p50_ms": round(statistics.median(cond), 1),
        "search_ms": round(search_ms, 1),
    }
    record_property("perf", stats)
    print("PERF", json.dumps(stats))
    assert s.startup_s < 10 and scan_ms < 3000
    assert statistics.median(times) < 300 and statistics.median(cond) < 50


def test_concurrent_reads_during_rescans(tmp_path: Path, serve: ServerFactory):
    from concurrent.futures import ThreadPoolExecutor

    root = tmp_path / "bulk"
    vb.build_bulk(root, n=300, body_kb=1)
    s = serve(root, HOUSEBOOK_RESCAN_INTERVAL="0.2")
    note = root / "House/Room1/Item 1.md"
    stop_at = time.monotonic() + 4

    def reader(_: int) -> list[int]:
        codes = []
        with httpx.Client(base_url=s.base, timeout=30) as c:
            while time.monotonic() < stop_at:
                for path in ["/api/snapshot", "/api/items?q=e1", "/api/items/it_000001", "/api/problems"]:
                    codes.append(c.get(path).status_code)
        return codes

    with ThreadPoolExecutor(8) as pool:
        futures = [pool.submit(reader, i) for i in range(8)]
        n = 0
        while time.monotonic() < stop_at:
            note.write_text(note.read_text() + f"\n- 2026-10-0{n % 9 + 1} edit {n}\n")
            n += 1
            time.sleep(0.05)
        codes = [c for f in futures for c in f.result()]
    assert codes and set(codes) == {200}, {c: codes.count(c) for c in set(codes)}


# --- milestone 4: writes, watcher, SSE on a real server ---------------------------------------------


def test_sse_writes_and_watcher_on_a_real_server(copy_examples: Path, serve: ServerFactory):
    s = serve(copy_examples, HOUSEBOOK_ANON_ROLE="editor", HOUSEBOOK_WATCH="inotify")
    events: list[tuple[str, dict]] = []

    with httpx.stream("GET", s.base + "/api/events", timeout=30) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["x-accel-buffering"] == "no" and r.headers["cache-control"] == "no-cache"
        lines = r.iter_lines()

        def next_event() -> tuple[str, dict]:
            name = None
            for line in lines:
                if line.startswith("event: "):
                    name = line.removeprefix("event: ")
                elif line.startswith("data: ") and name:
                    return name, json.loads(line.removeprefix("data: "))
            raise AssertionError("stream ended")

        assert next_event()[0] == "resync"

        # An app write: announced once, carrying the ETag the writer got back; no watcher echo.
        w = httpx.post(s.base + "/api/items/it_7f3k2a/log", json={"text": "Descaled"}, timeout=10)
        assert w.status_code == 200
        events.append(next_event())
        assert events[-1] == (
            "item.changed",
            {
                "id": "it_7f3k2a",
                "etag": w.json()["etag"],
                "path": "House/Kitchen/Dishwasher.md",
                "stale": False,
                "attachmentsEtag": w.json()["attachmentsEtag"],
            },
        )

        # An external edit (Obsidian): the watcher picks it up.
        path = copy_examples / "House" / "Kitchen" / "Fridge.md"
        path.write_text(path.read_text().replace("name: Fridge", "name: Fridge freezer"))
        events.append(next_event())
        assert events[-1][0] == "item.changed" and events[-1][1]["path"] == "House/Kitchen/Fridge.md"
    assert "rescan after file change failed" not in s.logs()


def test_second_instance_on_the_same_data_root_exits(copy_examples: Path, serve: ServerFactory):
    serve(copy_examples)
    second = serve(copy_examples, wait=False)
    assert second.proc.wait(20) != 0
    assert "lock" in second.logs()


def test_sigterm_with_an_open_event_stream_exits_promptly(copy_examples: Path, serve: ServerFactory):
    """uvicorn waits for open connections on shutdown; an SSE stream must not keep it alive."""
    import signal
    import threading

    s = serve(copy_examples)
    opened = threading.Event()

    def listen() -> None:
        with contextlib.suppress(httpx.HTTPError), httpx.stream("GET", s.base + "/api/events", timeout=30) as r:
            for line in r.iter_lines():
                if line.startswith("event: resync"):
                    opened.set()

    t = threading.Thread(target=listen, daemon=True)
    t.start()
    assert opened.wait(10)
    started = time.monotonic()
    s.proc.send_signal(signal.SIGTERM)
    s.proc.wait(10)
    assert time.monotonic() - started < 2, s.logs()
    t.join(5)
    assert not t.is_alive()  # the client saw the stream end
