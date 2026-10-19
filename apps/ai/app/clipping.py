"""Cutting an attempt out of a recording session's footage into a take of its own: the
clipper of Director's continuous recording (packages/contracts src/recording.ts).

The shoot screen records a whole session in ten-second slices; Director marks where each
attempt at a shot starts and ends, within a second or so. The clipper joins the part's
slices (a recorder's slices only play from the first, which holds the header), finds
where speech starts and stops around the marks (ffmpeg's silencedetect), snaps the marks
to the first and last words, and re-encodes that stretch as an ordinary, seekable H.264
MP4 a take can be (a long MediaRecorder recording has no seek index). It never cuts
across a pause: nothing was recorded there, and what's either side is another moment.

The footage is whatever bytes a member uploaded, so ffmpeg reads it defensively: the
first bytes must be the declared type's (WebM's EBML header, MP4's ftyp box), the demuxer
is pinned to that type instead of guessed from the content, it may open local files only
(no playlist or concat file reaching the network), and it runs through app/jail.py, with
no secrets in its environment and its CPU, file size and memory capped.

Seam: `Clipper` is what apps/worker reaches through this service's /v1/director/clips.
`LocalClipper` cuts in this process; `RemoteClipper` sends the same request to the Cloud
Run clipper (app/clipper.py, CLIPPER_URL), which runs a `LocalClipper`. Production always
uses the Cloud Run clipper (app/settings.py refuses it unset): ffmpeg decoding untrusted
footage belongs in a container with no secrets or data, not in this service's. The
footage comes and goes by presigned reads the worker signs: no storage credentials here.
"""

import asyncio
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx
import structlog
from fastapi import Response
from pydantic import ValidationError

from app.contracts.error_response import ErrorResponse
from app.errors import AppError
from app.google_auth import id_token
from app.log import log
from app.process import Runner, run_process
from app.schemas import ClipPause, ClipRequest

# A mark within this of a speech edge snaps to it, with a pad so the first and last
# sounds aren't clipped (the spec's 1.5 seconds and a quarter of one).
SNAP_REACH_MS = 1_500
SNAP_PAD_MS = 250
# An attempt with no end mark (Done, or the end marked in a later part) ends where the
# speaker first stops for this long, not at the footage's end: the chat after a take
# isn't part of it.
OPEN_END_SILENCE_MS = 1_500
# Speech is looked for this far around the marks: the reach, and the pad.
SPEECH_AROUND_MS = SNAP_REACH_MS + SNAP_PAD_MS
# Quieter than this for this long is a pause in speech (a room's hum stays under it).
SILENCE_FILTER = "silencedetect=noise=-35dB:d=0.3"
# A take's longest (packages/contracts api/director), and its shortest worth keeping.
MAX_CLIP_MS = 60_000
MIN_CLIP_MS = 500
# A cut is re-encoded at 30 frames a second (cut_args): the frames a take its shortest
# holds. ffmpeg exits happily from a cut with nothing in it (marks past where the footage
# really ends, or footage it can't decode there), so the cut is counted before it's a take.
CUT_FPS = 30
MIN_CLIP_FRAMES = MIN_CLIP_MS * CUT_FPS // 1000
# ffmpeg's progress line, "frame=   75 fps=...": how many frames it has read.
_FRAMES = re.compile(r"frame=\s*(\d+)")
# What a take's upload may be (packages/contracts files.ts, director-take-video): the
# encoder's caps keep a minute well under it.
MAX_CLIP_BYTES = 15_000_000
# A part's footage at most: its 150 slices of 8 MB.
MAX_FOOTAGE_BYTES = 150 * 8_000_000
SLICE_DOWNLOAD_SECONDS = 60.0
# Decoding 20 minutes to reach the last attempt, and encoding one minute, on one CPU.
FFMPEG_SECONDS = 300.0
# As long as Cloud Run lets the clipper answer (`--timeout` in docs/deploy.md): a whole
# part's download and both ffmpeg runs fit in it.
CLIP_REQUEST_SECONDS = 900.0
# Threads per ffmpeg, for decoding and encoding: two keep one cut from taking every core.
FFMPEG_THREADS = "2"
# ffmpeg runs through this (see the module's docstring).
JAIL = [sys.executable, str(Path(__file__).with_name("jail.py"))]
# The jail's answer when ffmpeg can't be started (app/jail.py).
CANNOT_START = 127
# The demuxer for each type a part may be: never left to ffmpeg's probing, which would
# open whatever format the bytes claim to be (an HLS playlist, a concat list, ...).
DEMUXERS = {"video/webm": "matroska", "video/mp4": "mov"}

_SILENCE_START = re.compile(r"silence_start: (-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end: (-?[\d.]+)")


@dataclass(frozen=True)
class Span:
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Speech:
    """Where speech starts (onsets) and stops (offsets), in the part's clock."""

    onsets: list[int]
    offsets: list[int]


@dataclass(frozen=True)
class Clip:
    """The take, an MP4, and where in the part it was cut."""

    video: bytes
    start_ms: int
    end_ms: int


class ClipFailed(Exception):
    """An attempt that couldn't be cut: whether trying again may succeed (the footage
    unreachable for now) or not (nothing to cut, or footage ffmpeg can't read)."""

    def __init__(self, cause: str, *, retryable: bool) -> None:
        super().__init__(cause)
        self.retryable = retryable


def speech_in(log_text: str, around: Span) -> Speech:
    """The speech edges in silencedetect's log for the stretch `around`: a silence's end
    is where speech starts, and its start where speech stops. A silence the stretch opens
    or closes with says nothing about speech (it's where the looking began or ended)."""

    def edges(pattern: re.Pattern[str]) -> list[int]:
        seconds = [float(match.group(1)) for match in pattern.finditer(log_text)]
        return [around.start_ms + max(0, round(second * 1000)) for second in seconds]

    return Speech(
        onsets=[edge for edge in edges(_SILENCE_END) if edge < around.end_ms],
        offsets=[edge for edge in edges(_SILENCE_START) if edge > around.start_ms],
    )


def within_pauses(start_ms: int, pauses: list[ClipPause], footage_end_ms: int) -> Span:
    """The stretch between the pauses around an attempt starting at `start_ms`, which no
    cut may leave. A start inside a pause moves to its end."""
    lower, upper = 0, footage_end_ms
    for pause in pauses:
        pause_end = footage_end_ms if pause.endMs is None else pause.endMs
        if pause_end <= start_ms or pause.startMs <= start_ms:
            lower = max(lower, pause_end)
        else:
            upper = min(upper, pause.startMs)
    return Span(lower, upper)


def looks_like(head: bytes, content_type: str) -> bool:
    """Whether a recording's first bytes are its declared type's: WebM's EBML header, or
    an MP4's ftyp box (packages/contracts src/recording.ts checks the same on upload)."""
    if content_type == "video/webm":
        return head[:4] == b"\x1a\x45\xdf\xa3"
    return head[4:8] == b"ftyp"


def _within_reach(edges: list[int], at_ms: int) -> list[int]:
    return [edge for edge in edges if abs(edge - at_ms) <= SNAP_REACH_MS]


def _nearest(edges: list[int], at_ms: int) -> int | None:
    """The edge nearest `at_ms` within the snap's reach (the earlier of two as near)."""
    return min(
        _within_reach(edges, at_ms), key=lambda edge: (abs(edge - at_ms), edge), default=None
    )


def first_pause_after(speech: Speech, start_ms: int, until_ms: int) -> int | None:
    """Where speech after `start_ms` first stops for OPEN_END_SILENCE_MS, or for good
    before `until_ms`: the end of an attempt Director never marked."""
    for offset in (edge for edge in speech.offsets if edge > start_ms):
        resumes = min((edge for edge in speech.onsets if edge > offset), default=until_ms)
        if resumes - offset >= OPEN_END_SILENCE_MS or resumes >= until_ms:
            return offset
    return None


def snap(marks: Span, speech: Speech, bounds: Span, *, open_end: bool = False) -> Span:
    """Director's marks moved onto the first and last words near them, padded, inside
    `bounds`, at most a take long. The start goes to the earliest word within reach of
    its mark (Director marks a start once it has heard it), the end to the speech edge
    nearest its mark; an `open_end` (none was marked) to where the speaker first stops
    for a while. A mark with no speech edge near it (a shot without speech) stays where
    Director put it."""
    onset = min(_within_reach(speech.onsets, marks.start_ms), default=None)
    offset = (
        first_pause_after(speech, marks.start_ms, marks.end_ms)
        if open_end
        else _nearest(speech.offsets, marks.end_ms)
    )
    start = marks.start_ms if onset is None else onset - SNAP_PAD_MS
    end = marks.end_ms if offset is None else offset + SNAP_PAD_MS
    start = max(bounds.start_ms, start)
    end = min(bounds.end_ms, end, start + MAX_CLIP_MS)
    return Span(start, end)


def _seconds(ms: int) -> str:
    return f"{ms / 1000:.3f}"


def _input(footage: Path, content_type: str) -> list[str]:
    """ffmpeg's input, read as its declared type and nothing else, from this file only."""
    return [
        "-protocol_whitelist",
        "file",
        "-threads",
        FFMPEG_THREADS,
        "-f",
        DEMUXERS[content_type],
        "-i",
        f"file:{footage}",
    ]


def speech_args(footage: Path, content_type: str, around: Span) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-ss",
        _seconds(around.start_ms),
        *_input(footage, content_type),
        "-t",
        _seconds(around.end_ms - around.start_ms),
        "-vn",
        "-af",
        SILENCE_FILTER,
        "-f",
        "null",
        "-",
    ]


def cut_args(footage: Path, content_type: str, span: Span, out: Path) -> list[str]:
    """Frame-accurate (seeking decodes from the keyframe before and drops up to the
    start), at most 1280 pixels on the long side and 30 frames a second, about 1.6 Mbit/s
    in all: what the editor plays and Gemini reviews."""
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-y",
        "-ss",
        _seconds(span.start_ms),
        *_input(footage, content_type),
        "-t",
        _seconds(span.end_ms - span.start_ms),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale=w='min(iw,1280)':h='min(ih,1280)':force_original_aspect_ratio=decrease"
        f":force_divisible_by=2,fps={CUT_FPS}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-maxrate",
        "1500k",
        "-bufsize",
        "3000k",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ac",
        "1",
        "-threads",
        FFMPEG_THREADS,
        "-movflags",
        "+faststart",
        f"file:{out}",
    ]


def count_args(take: Path) -> list[str]:
    """Reads a cut's picture through, decoding nothing out (its frame count is in the
    progress ffmpeg logs). An MP4 with no picture at all fails the `-map`."""
    return [
        *("ffmpeg", "-hide_banner", "-stats"),
        *_input(take, "video/mp4"),
        *("-map", "0:v:0", "-f", "null", "-"),
    ]


def frames_in(log_text: str) -> int:
    """How many frames ffmpeg's progress says it read: none when it read none."""
    return max((int(found.group(1)) for found in _FRAMES.finditer(log_text)), default=0)


class Clipper(Protocol):
    async def clip(self, request: ClipRequest) -> Clip:
        """The attempt's take (ClipFailed when there's none to be had)."""
        ...


class LocalClipper:
    """Cuts in this process, with ffmpeg, one attempt at a time: a cut holds a whole
    part's footage on disk and two of ffmpeg's threads, so a second one waits its turn
    rather than doubling both (the worker retries a cut that waits too long)."""

    def __init__(self, http: httpx.AsyncClient, run: Runner = run_process) -> None:
        self._http = http
        self._run = run
        self._one_at_a_time = asyncio.Semaphore(1)

    async def clip(self, request: ClipRequest) -> Clip:
        async with self._one_at_a_time:
            return await self._clip(request)

    async def _clip(self, request: ClipRequest) -> Clip:
        last = request.slices[-1]
        footage_end = last.startMs + last.durationMs
        bounds = within_pauses(request.startMs, request.pauses, footage_end)
        # Unmarked, the end is looked for in the take's longest after its start.
        end = request.startMs + MAX_CLIP_MS if request.endMs is None else request.endMs
        marks = Span(max(request.startMs, bounds.start_ms), min(end, bounds.end_ms))
        if marks.end_ms - marks.start_ms < MIN_CLIP_MS:
            raise ClipFailed("nothing to cut between the marks", retryable=False)
        with tempfile.TemporaryDirectory() as tmp:
            footage = Path(tmp) / "footage"
            await self._download(request, footage)
            around = Span(
                max(bounds.start_ms, marks.start_ms - SPEECH_AROUND_MS),
                min(bounds.end_ms, marks.end_ms + SPEECH_AROUND_MS),
            )
            speech = await self._speech(footage, request.contentType, around)
            span = snap(marks, speech, bounds, open_end=request.endMs is None)
            if span.end_ms - span.start_ms < MIN_CLIP_MS:
                raise ClipFailed("nothing to cut between the marks", retryable=False)
            out = Path(tmp) / "take.mp4"
            args = cut_args(footage, request.contentType, span, out)
            await self._ffmpeg(args, "cut the take")
            code, stderr = await self._timed(count_args(out))
            frames = frames_in(stderr.decode(errors="replace")) if code == 0 else 0
            if frames < MIN_CLIP_FRAMES:
                log.warning("the cut came out empty", frames=frames, exit_code=code)
                raise ClipFailed("the cut came out empty", retryable=False)
            video = await asyncio.to_thread(out.read_bytes)
        if len(video) > MAX_CLIP_BYTES:
            raise ClipFailed("the take came out larger than a take may be", retryable=False)
        return Clip(video=video, start_ms=span.start_ms, end_ms=span.end_ms)

    async def _download(self, request: ClipRequest, footage: Path) -> None:
        """The part's slices, joined in order: one recording, as the recorder made it."""
        size = 0
        with footage.open("wb") as joined:
            for index, piece in enumerate(request.slices):
                try:
                    async with self._http.stream(
                        "GET", piece.url, timeout=SLICE_DOWNLOAD_SECONDS
                    ) as response:
                        _ = response.raise_for_status()
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > MAX_FOOTAGE_BYTES:
                                raise ClipFailed("more footage than a part has", retryable=False)
                            _ = joined.write(chunk)
                except httpx.HTTPError as error:
                    # Only what went wrong: the URL is a credential (its signature).
                    log.warning(
                        "couldn't fetch a slice",
                        attempt_id=str(request.attemptId),
                        slice=index,
                        error=type(error).__name__,
                    )
                    raise ClipFailed("a slice couldn't be fetched", retryable=True) from None
        with footage.open("rb") as joined:
            head = joined.read(12)
        if not looks_like(head, request.contentType):
            # apps/api refuses such a first slice; this holds for any that got past it.
            raise ClipFailed("the footage isn't the recording it says it is", retryable=False)

    async def _speech(self, footage: Path, content_type: str, around: Span) -> Speech:
        """Speech edges around the marks; none when there's no sound to read (no
        microphone): the marks then stand."""
        code, stderr = await self._timed(speech_args(footage, content_type, around))
        if code != 0:
            log.info("no speech to snap to", exit_code=code)
            return Speech(onsets=[], offsets=[])
        return speech_in(stderr.decode(errors="replace"), around)

    async def _ffmpeg(self, args: list[str], what: str) -> None:
        code, stderr = await self._timed(args)
        if code != 0:
            log.warning(
                f"ffmpeg couldn't {what}",
                exit_code=code,
                stderr=stderr.decode(errors="replace")[-500:],
            )
            raise ClipFailed(f"ffmpeg couldn't {what}", retryable=False)

    async def _timed(self, args: list[str]) -> tuple[int | None, bytes]:
        try:
            async with asyncio.timeout(FFMPEG_SECONDS):
                code, stderr = await self._run([*JAIL, *args])
        except TimeoutError:
            raise ClipFailed("ffmpeg took too long", retryable=False) from None
        except OSError as error:
            # The jail's Python couldn't start: this machine's fault, not the footage's.
            log.exception("couldn't run ffmpeg")
            raise ClipFailed("ffmpeg couldn't start", retryable=True) from error
        if code == CANNOT_START:
            # ffmpeg missing or not executable: as above.
            log.error("ffmpeg couldn't start", stderr=stderr.decode(errors="replace")[-500:])
            raise ClipFailed("ffmpeg couldn't start", retryable=True)
        return code, stderr


class RemoteClipper:
    """Sends the request to the Cloud Run clipper at `url` (app/clipper.py), as this
    machine's service account: an ID token for `url` from the metadata server, which
    Cloud Run's IAM and the clipper itself both check."""

    def __init__(self, url: str, http: httpx.AsyncClient) -> None:
        self._url = url
        self._http = http

    async def clip(self, request: ClipRequest) -> Clip:
        try:
            token = await id_token(self._url)
            response = await self._http.post(
                f"{self._url}/v1/clip",
                content=request.model_dump_json(),
                headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
                timeout=CLIP_REQUEST_SECONDS,
            )
        except httpx.HTTPError as error:
            log.warning("couldn't reach the clipper", error=type(error).__name__)
            raise ClipFailed("the clipper couldn't be reached", retryable=True) from None
        if not response.is_success:
            raise _refused(response)
        try:
            start_ms = int(response.headers["x-clip-start-ms"])
            end_ms = int(response.headers["x-clip-end-ms"])
        except KeyError, ValueError:
            # Another version of the clipper (it's deployed by hand).
            log.warning("the clipper's answer doesn't say where it cut")
            raise ClipFailed("the clipper's answer can't be read", retryable=False) from None
        return Clip(video=response.content, start_ms=start_ms, end_ms=end_ms)


def _refused(response: httpx.Response) -> ClipFailed:
    """The clipper's error answer: its own says whether the attempt can be cut at all;
    anything else is Cloud Run's (IAM, busy, failing), worth a retry only for an outage."""
    status = response.status_code
    try:
        code = ErrorResponse.model_validate_json(response.content).code
    except ValidationError:
        code = None
    log.warning("the clipper refused an attempt", status=status, code=code)
    if code == "RECORDING_CLIP_FAILED":
        return ClipFailed("the clipper couldn't cut it", retryable=False)
    return ClipFailed(f"the clipper answered {status}", retryable=status == 429 or status >= 500)


async def clip_response(clipper: Clipper, body: ClipRequest) -> Response:
    """The take as an MP4 and where it was cut, or the attempt's failure as an error:
    one answer for this clipper and the AI service's own route."""
    structlog.contextvars.bind_contextvars(attempt_id=str(body.attemptId))
    try:
        clip = await clipper.clip(body)
    except ClipFailed as failure:
        if failure.retryable:
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "clipper"}) from None
        raise AppError("RECORDING_CLIP_FAILED") from None
    return Response(
        content=clip.video,
        media_type="video/mp4",
        headers={"x-clip-start-ms": str(clip.start_ms), "x-clip-end-ms": str(clip.end_ms)},
    )
