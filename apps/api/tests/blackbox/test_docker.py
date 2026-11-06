"""Black-box tests of the Docker image (opt-in: HOUSEBOOK_BLACKBOX=1 HOUSEBOOK_DOCKER=1).

Runs the image the way compose.yaml does: host UID/GID, read-only root filesystem, tmpfs /tmp,
all capabilities dropped, no-new-privileges, a bind-mounted data directory.
"""

import contextlib
import json
import os
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import httpx2 as httpx
import pytest

from .conftest import EXAMPLES, REPO, free_port

pytestmark = pytest.mark.docker
IMAGE = "housebook:blackbox"


def docker(*args: str, check: bool = True, timeout: float = 600) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)


@pytest.fixture(scope="session")
def image() -> str:
    if not shutil.which("docker"):
        pytest.skip("docker not installed")
    uid, gid = os.getuid(), os.getgid()
    docker("build", "-t", IMAGE, "--build-arg", f"UID={uid}", "--build-arg", f"GID={gid}", str(REPO), timeout=1200)
    return IMAGE


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    root = tmp_path / "data"
    shutil.copytree(EXAMPLES, root, ignore=shutil.ignore_patterns(".housebook"))
    return root


class Container:
    def __init__(self, name: str, port: int) -> None:
        self.name, self.base = name, f"http://127.0.0.1:{port}"

    def inspect(self) -> dict:
        return json.loads(docker("inspect", self.name).stdout)[0]

    def exec(self, *cmd: str) -> subprocess.CompletedProcess:
        return docker("exec", self.name, *cmd, check=False)

    def logs(self) -> str:
        r = docker("logs", self.name, check=False)
        return r.stdout + r.stderr


@pytest.fixture
def run(image: str) -> Iterator:
    names: list[str] = []

    def factory(data: Path, *extra: str, wait: bool = True, mount: str = "rw") -> Container:
        name = f"housebook-bb-{uuid.uuid4().hex[:8]}"
        port = free_port()
        names.append(name)
        docker(
            "run", "-d", "--name", name,
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--read-only", "--tmpfs", "/tmp",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "-e", "HOUSEBOOK_TZ=Europe/Athens",
            "-v", f"{data}:/data:{mount}",
            "-p", f"127.0.0.1:{port}:8000",
            *extra, image,
        )  # fmt: skip
        c = Container(name, port)
        if wait:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                with contextlib.suppress(httpx.HTTPError):
                    if httpx.get(c.base + "/healthz", timeout=1).status_code == 200:
                        return c
                if not c.inspect()["State"]["Running"]:
                    raise RuntimeError("container exited:\n" + c.logs())
                time.sleep(0.3)
            raise RuntimeError("container did not come up:\n" + c.logs())
        return c

    yield factory
    for n in names:
        docker("rm", "-f", n, check=False)


def test_image_metadata(image: str):
    cfg = json.loads(docker("image", "inspect", image).stdout)[0]["Config"]
    assert cfg["User"] not in ("", "0", "root", "0:0")
    assert cfg["Healthcheck"]["Test"][0] == "CMD" and "/readyz" in " ".join(cfg["Healthcheck"]["Test"])
    assert "8000/tcp" in cfg["ExposedPorts"] and "/data" in cfg["Volumes"]


def test_serves_api_as_non_root_with_read_only_rootfs(run, data_dir: Path):
    c = run(data_dir)
    assert c.exec("id", "-u").stdout.strip() == str(os.getuid())
    assert c.exec("cat", "/proc/1/status").stdout.count(f"\t{os.getuid()}\t") >= 1
    assert c.exec("touch", "/app/x").returncode != 0  # root fs is read-only
    assert c.exec("touch", "/tmp/x").returncode == 0
    snap = httpx.get(c.base + "/api/snapshot").json()
    assert len(snap["items"]) == 14 and snap["timezone"] == "Europe/Athens"
    assert httpx.get(c.base + "/readyz").json()["checks"] == {"scanned": True, "dataWritable": True}
    lock = data_dir / ".housebook" / "lock"
    assert lock.exists() and lock.stat().st_uid == os.getuid()
    assert httpx.get(c.base + "/api/items/it_7f3k2a/attachments/manual.pdf").status_code == 200


def test_healthcheck_goes_healthy(run, data_dir: Path):
    c = run(data_dir, "--health-interval=1s", "--health-start-period=1s")  # same CMD, faster cadence
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        status = c.inspect()["State"]["Health"]["Status"]
        if status == "healthy":
            break
        assert status != "unhealthy", c.inspect()["State"]["Health"]["Log"]
        time.sleep(0.5)
    assert status == "healthy"


def test_read_only_data_mount_is_unhealthy_but_serves(run, data_dir: Path):
    c = run(data_dir, mount="ro")
    assert httpx.get(c.base + "/readyz").status_code == 503
    assert httpx.get(c.base + "/api/house").status_code == 200


def test_second_container_on_same_data_root_exits(run, data_dir: Path):
    first = run(data_dir)
    second = run(data_dir, wait=False)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and second.inspect()["State"]["Running"]:
        time.sleep(0.3)
    state = second.inspect()["State"]
    assert not state["Running"] and state["ExitCode"] != 0
    assert "lock" in second.logs().lower()
    assert httpx.get(first.base + "/readyz").status_code == 200


def test_sigterm_stops_quickly_and_releases_lock(run, data_dir: Path):
    import threading

    c = run(data_dir)
    opened = threading.Event()

    def listen() -> None:  # an open event stream must not delay the stop
        with contextlib.suppress(httpx.HTTPError), httpx.stream("GET", c.base + "/api/events", timeout=30) as r:
            for line in r.iter_lines():
                if line.startswith("event: resync"):
                    opened.set()

    threading.Thread(target=listen, daemon=True).start()
    assert opened.wait(10)
    t = time.monotonic()
    docker("stop", "-t", "10", c.name)
    assert time.monotonic() - t < 3, c.logs()
    assert c.inspect()["State"]["ExitCode"] == 0
    run(data_dir)  # lock released: a new instance starts
