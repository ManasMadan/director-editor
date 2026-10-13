"""Proof of life for the worker, which has no port for Kubernetes to probe.

While its event loop runs, the worker touches a file every few seconds (`beat`); the
liveness probe runs `python -m app.heartbeat`, which fails once the file is older than
`STALE_AFTER` seconds. So a worker whose loop is stuck (a blocking call, a deadlock) is
restarted instead of sitting there with its jobs.
"""

import asyncio
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

HEARTBEAT = Path(tempfile.gettempdir()) / "ai-worker-alive"
EVERY = 10.0
STALE_AFTER = 60.0


async def beat(path: Path = HEARTBEAT, every: float = EVERY) -> None:
    """Touches `path` every `every` seconds, until cancelled."""
    while True:
        await asyncio.to_thread(path.touch)
        await asyncio.sleep(every)


def alive(
    path: Path = HEARTBEAT, stale_after: float = STALE_AFTER, now: Callable[[], float] = time.time
) -> bool:
    """Whether `path` was touched in the last `stale_after` seconds."""
    try:
        return now() - path.stat().st_mtime < stale_after
    except FileNotFoundError:
        return False


if __name__ == "__main__":
    sys.exit(0 if alive() else 1)
