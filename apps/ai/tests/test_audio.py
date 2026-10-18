"""Pure tests for app/audio.py: a fake runner and a fake uploader, never a real yt-dlp
process or Cloud Storage call, except for the two default implementations themselves,
which run for real against a harmless process and a fake Cloud Storage client."""

import asyncio
import os
import sys
from pathlib import Path

import pytest

from app.audio import fetch_audio, run_yt_dlp, upload_to_gcs
from app.audio import storage as gcs

VIDEO = "dQw4w9WgXcQ"
BUCKET = "director-shorts"


async def _writes_the_file(args: list[str]) -> tuple[int, bytes]:
    """A fake yt-dlp: writes the output file its real counterpart would, at the path
    `fetch_audio` told it to (-o), and exits 0."""
    template = args[args.index("-o") + 1]
    path = Path(template.replace("%(ext)s", "m4a"))
    await asyncio.to_thread(path.write_bytes, b"fake audio")
    return 0, b""


async def _fails(args: list[str]) -> tuple[int, bytes]:
    return 1, b"ERROR: Video unavailable"


async def test_fetch_audio_uploads_and_returns_the_object_key() -> None:
    uploaded: list[tuple[str, str, bytes]] = []

    async def upload(bucket: str, key: str, path: Path) -> None:
        data = await asyncio.to_thread(path.read_bytes)
        uploaded.append((bucket, key, data))

    key = await fetch_audio(VIDEO, BUCKET, run=_writes_the_file, upload=upload)

    assert key == f"audio/{VIDEO}.m4a"
    assert uploaded == [(BUCKET, key, b"fake audio")]


async def test_fetch_audio_returns_none_when_yt_dlp_exits_non_zero() -> None:
    async def upload(bucket: str, key: str, path: Path) -> None:
        pytest.fail("never uploads when yt-dlp failed")

    assert await fetch_audio(VIDEO, BUCKET, run=_fails, upload=upload) is None


async def test_fetch_audio_returns_none_when_the_upload_fails() -> None:
    async def upload(bucket: str, key: str, path: Path) -> None:
        raise OSError("bucket unreachable")

    assert await fetch_audio(VIDEO, BUCKET, run=_writes_the_file, upload=upload) is None


async def test_fetch_audio_returns_none_when_the_runner_raises() -> None:
    # yt-dlp missing or not executable: create_subprocess_exec raises instead of
    # returning an exit code.
    async def run(args: list[str]) -> tuple[int, bytes]:
        raise FileNotFoundError("yt-dlp: not found")

    async def upload(bucket: str, key: str, path: Path) -> None:
        pytest.fail("never uploads when the runner couldn't even start")

    assert await fetch_audio(VIDEO, BUCKET, run=run, upload=upload) is None


@pytest.mark.parametrize("malformed", ["../evil/xyz", "short"])
async def test_fetch_audio_refuses_a_malformed_video_id(malformed: str) -> None:
    async def run(args: list[str]) -> tuple[int, bytes]:
        pytest.fail("never runs yt-dlp for an id that failed validation")

    async def upload(bucket: str, key: str, path: Path) -> None:
        pytest.fail("never uploads for an id that failed validation")

    assert await fetch_audio(malformed, BUCKET, run=run, upload=upload) is None


async def test_fetch_audio_gives_up_on_a_yt_dlp_that_hangs() -> None:
    async def hangs(args: list[str]) -> tuple[int, bytes]:
        await asyncio.Event().wait()
        return 0, b""

    async def upload(bucket: str, key: str, path: Path) -> None:
        pytest.fail("never uploads what yt-dlp never finished")

    assert await fetch_audio(VIDEO, BUCKET, run=hangs, upload=upload, give_up_after=0.05) is None


async def test_run_yt_dlp_kills_the_process_when_it_is_given_up_on(tmp_path: Path) -> None:
    pid_file = tmp_path / "pid"
    sleeper = (
        "import os, pathlib, time; "
        f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)"
    )
    # Long enough for the process to start and say who it is, far short of its minute.
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(run_yt_dlp([sys.executable, "-c", sleeper]), timeout=3)
    # Killed and reaped: no process with that id is left behind.
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


async def test_run_yt_dlp_runs_a_real_subprocess_and_reports_its_exit() -> None:
    # A harmless process standing in for yt-dlp: no network, no binary this test depends on.
    code, stderr = await run_yt_dlp(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"]
    )

    assert (code, stderr) == (3, b"boom")


async def test_upload_to_gcs_uploads_through_the_bucket_and_blob(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, str, str]] = []

    class FakeBlob:
        def __init__(self, bucket_name: str, key: str) -> None:
            self._bucket_name = bucket_name
            self._key = key

        def upload_from_filename(self, filename: str) -> None:
            calls.append((self._bucket_name, self._key, filename))

    class FakeBucket:
        def __init__(self, name: str) -> None:
            self._name = name

        def blob(self, key: str) -> FakeBlob:
            return FakeBlob(self._name, key)

    class FakeClient:
        def bucket(self, name: str) -> FakeBucket:
            return FakeBucket(name)

    monkeypatch.setattr(gcs, "Client", FakeClient)
    audio_file = tmp_path / "clip.m4a"
    audio_file.write_bytes(b"audio")

    await upload_to_gcs(BUCKET, f"audio/{VIDEO}.m4a", audio_file)

    assert calls == [(BUCKET, f"audio/{VIDEO}.m4a", str(audio_file))]
