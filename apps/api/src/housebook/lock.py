"""Single-process guard (DESIGN 15.5): exclusive flock on <data>/.housebook/lock.

The watcher, SSE fan-out and in-memory index all assume one process per data root.
flock is advisory and unreliable on NFS; there it only catches same-host duplicates.
"""

import fcntl
import os
from pathlib import Path


class LockHeld(RuntimeError):
    pass


class ProcessLock:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / ".housebook" / "lock"
        self._fd: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise LockHeld(
                f"{self.path} is locked: another Housebook process is using this data folder. "
                "Run one instance per data root (one worker, replicas: 1, strategy: Recreate)."
            ) from None
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        self._fd = fd

    def release(self) -> None:
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None
