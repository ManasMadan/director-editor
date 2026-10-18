"""Running a command-line tool (yt-dlp for a short's audio, ffmpeg for cutting a take)
as a real subprocess. Callers take it as an injectable runner, so their tests can fake the
tool instead of needing it installed."""

import asyncio
from collections.abc import Awaitable, Callable

type Runner = Callable[[list[str]], Awaitable[tuple[int | None, bytes]]]


async def run_process(args: list[str]) -> tuple[int | None, bytes]:
    """Runs `args`: its exit code and whatever it wrote to stderr. Given up on (cancelled,
    or timed out by the caller), the process is killed and reaped, never left running."""
    # No shell: each argument reaches the process as its own argv entry, never interpreted.
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    try:
        _, stderr = await process.communicate()
    except asyncio.CancelledError:
        process.kill()
        _ = await process.wait()
        raise
    return process.returncode, stderr
