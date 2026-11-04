"""Opt-in black-box suite: real `housebook serve` processes (and the Docker image) over HTTP.

Skipped by default. Run with:

    HOUSEBOOK_BLACKBOX=1 uv run pytest tests/blackbox -m blackbox            # uvicorn processes
    HOUSEBOOK_BLACKBOX=1 HOUSEBOOK_DOCKER=1 uv run pytest tests/blackbox    # + Docker image

The Docker tests build `housebook:blackbox` from the repo root once per session.
"""

import contextlib
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx2 as httpx
import pytest

REPO = Path(__file__).resolve().parents[4]
CONTRACT = REPO / "contract"
EXAMPLES = REPO / "examples" / "house"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    here = Path(__file__).parent
    for item in items:
        if here not in Path(item.fspath).parents:
            continue
        item.add_marker(pytest.mark.blackbox)
        if os.environ.get("HOUSEBOOK_BLACKBOX") != "1":
            item.add_marker(pytest.mark.skip(reason="black-box suite: set HOUSEBOOK_BLACKBOX=1"))
        elif "docker" in item.keywords and os.environ.get("HOUSEBOOK_DOCKER") != "1":
            item.add_marker(pytest.mark.skip(reason="Docker suite: set HOUSEBOOK_DOCKER=1"))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Server:
    proc: subprocess.Popen
    base: str
    log: Path
    startup_s: float

    def get(self, path: str, **kw) -> httpx.Response:
        return httpx.get(self.base + path, timeout=30, **kw)

    def logs(self) -> str:
        return self.log.read_text(errors="replace")


def _env(data: Path, port: int, extra: dict[str, str]) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("HOUSEBOOK_")}
    env.update(
        HOUSEBOOK_DATA_DIR=str(data),
        HOUSEBOOK_CONTRACT_DIR=str(CONTRACT),
        HOUSEBOOK_HOST="127.0.0.1",
        HOUSEBOOK_PORT=str(port),
        HOUSEBOOK_TZ="Europe/Athens",
        HOUSEBOOK_RESCAN_INTERVAL="0",
    )
    env.update(extra)
    return env


def launch(data: Path, log: Path, env: dict[str, str] | None = None, wait: bool = True) -> Server:
    port = int((env or {}).get("HOUSEBOOK_PORT") or free_port())
    full_env = _env(data, port, {**(env or {}), "HOUSEBOOK_PORT": str(port)})
    started = time.perf_counter()
    proc = subprocess.Popen(
        [sys.executable, "-m", "housebook", "serve"],
        env=full_env,
        stdout=log.open("wb"),
        stderr=subprocess.STDOUT,
    )
    host = full_env["HOUSEBOOK_HOST"]
    base = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    server = Server(proc, base, log, 0.0)
    if not wait:
        return server
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited with {proc.returncode}:\n{log.read_text(errors='replace')}")
        with contextlib.suppress(httpx.HTTPError):
            if httpx.get(base + "/readyz", timeout=1).status_code in (200, 503):
                server.startup_s = time.perf_counter() - started
                return server
        time.sleep(0.05)
    stop(server)
    raise RuntimeError("server did not come up:\n" + log.read_text(errors="replace"))


def stop(server: Server) -> None:
    if server.proc.poll() is None:
        server.proc.send_signal(signal.SIGTERM)
        try:
            server.proc.wait(10)
        except subprocess.TimeoutExpired:
            server.proc.kill()
            server.proc.wait()


@pytest.fixture
def copy_examples(tmp_path: Path) -> Path:
    root = tmp_path / "data"
    shutil.copytree(EXAMPLES, root, ignore=shutil.ignore_patterns(".housebook"))
    return root


ServerFactory = Callable[..., Server]


@pytest.fixture
def serve(tmp_path: Path) -> Iterator[ServerFactory]:
    servers: list[Server] = []

    def factory(data: Path, wait: bool = True, **env: str) -> Server:
        log = tmp_path / f"server-{len(servers)}.log"
        s = launch(data, log, {k.upper(): str(v) for k, v in env.items()}, wait=wait)
        servers.append(s)
        return s

    yield factory
    for s in servers:
        stop(s)
