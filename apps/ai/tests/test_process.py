"""app/process.py: a tool run as a real subprocess, against a harmless Python process."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

from app.process import run_process


async def test_a_process_given_up_on_is_killed_and_reaped(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    sleeper = (
        "import os, pathlib, time; "
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    # Long enough for the process to start and say who it is, far short of its minute.
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(run_process([sys.executable, "-c", sleeper]), timeout=3)
    # Killed and reaped: no process with that id is left behind.
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


async def test_a_process_reports_its_exit_and_what_it_wrote_to_stderr() -> None:
    # A harmless process standing in for a tool: no network, no binary this test depends on.
    code, stderr = await run_process(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"]
    )

    assert (code, stderr) == (3, b"boom")
