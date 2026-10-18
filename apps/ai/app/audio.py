"""Capturing a short's original audio with yt-dlp, while it's indexed (app/indexing.py's
LocalIndexer, once the plan is written).

yt-dlp runs as a subprocess (app/process.py), behind an injectable runner so tests fake
it instead of reaching the network or a real binary; what it extracts is uploaded to Cloud
Storage with Application Default Credentials (no key file), behind an injectable uploader
for the same reason. Any failure (yt-dlp can't reach the video, hangs past AUDIO_TIMEOUT_SECONDS, no
audio comes out, the upload fails) is logged and swallowed, never raised: a short with
no audio capture still gets its plan.
"""

import asyncio
import re
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path

from google.cloud import storage  # pyright: ignore[reportMissingTypeStubs]

from app.log import log
from app.process import Runner, run_process
from app.schemas import VIDEO_ID_PATTERN

type Uploader = Callable[[str, str, Path], Awaitable[None]]

# A Short's audio (three minutes at most) downloads in seconds; past this yt-dlp is stuck
# (a throttled or stalled stream), and the plan it follows is held up waiting for it.
AUDIO_TIMEOUT_SECONDS = 120.0


async def upload_to_gcs(bucket: str, key: str, path: Path) -> None:
    """Uploads `path` to `gs://{bucket}/{key}`, authenticated with Application Default
    Credentials (the cluster's workload identity, or `gcloud auth application-default
    login` locally): never a key file."""
    await asyncio.to_thread(_upload, bucket, key, path)


def _upload(bucket: str, key: str, path: Path) -> None:
    client = storage.Client()
    client.bucket(bucket).blob(key).upload_from_filename(  # pyright: ignore[reportUnknownMemberType]
        str(path)
    )


async def fetch_audio(
    video_id: str,
    bucket: str,
    *,
    run: Runner = run_process,
    upload: Uploader = upload_to_gcs,
    give_up_after: float = AUDIO_TIMEOUT_SECONDS,
) -> str | None:
    """Downloads `video_id`'s audio with yt-dlp and uploads it to `bucket`, returning its
    object key (`audio/{video_id}.m4a`). Any failure is logged and answered with None,
    never raised: a short with no audio capture still gets its shot plan."""
    if not re.fullmatch(VIDEO_ID_PATTERN, video_id):
        # Also what keeps it out of the temp file path and the GCS key below: a malformed
        # id never reaches either, so there's nothing there to escape with.
        log.warning("refusing to fetch audio for a malformed video id")
        return None
    key = f"audio/{video_id}.m4a"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"{video_id}.m4a"
        args = [
            "yt-dlp",
            "-x",
            "--audio-format",
            "m4a",
            "-o",
            str(Path(tmp) / f"{video_id}.%(ext)s"),
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        try:
            async with asyncio.timeout(give_up_after):
                code, stderr = await run(args)
        except TimeoutError:
            log.warning("yt-dlp took too long; giving up on the audio", video_id=video_id)
            return None
        except Exception:
            # yt-dlp missing, not executable, or otherwise unable to start.
            log.exception("couldn't run yt-dlp", video_id=video_id)
            return None
        if code != 0:
            log.warning(
                "yt-dlp failed to fetch a short's audio",
                video_id=video_id,
                exit_code=code,
                stderr=stderr.decode(errors="replace")[:500],
            )
            return None
        try:
            await upload(bucket, key, path)
        except Exception:
            log.exception("failed to upload a short's audio", video_id=video_id, bucket=bucket)
            return None
    return key
