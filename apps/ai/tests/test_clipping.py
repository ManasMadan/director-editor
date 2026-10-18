"""Cutting a recorded attempt into a take (app/clipping.py, app/clipper.py): the snapping
rules on their own, then a real short recording (made with ffmpeg, split into slices as
the browser uploads them) cut by real ffmpeg, through the AI service's route, the Cloud
Run clipper and the remote clipper that calls it. Storage is a local server answering
presigned reads (tests/fakes.py), the metadata server and Google's certificates too."""

import asyncio
import json
import re
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app import clipping
from app.clipping import (
    MAX_CLIP_MS,
    Clip,
    ClipFailed,
    LocalClipper,
    RemoteClipper,
    Span,
    Speech,
    first_pause_after,
    looks_like,
    snap,
    speech_in,
    within_pauses,
)
from app.process import run_process
from app.schemas import ClipPause, ClipRequest, ClipSlice
from app.settings import get_clipper_settings
from tests.fakes import CERTS_PATH, Fake, Identity, serve_files, serve_identity
from tests.support import error_of, headers, new_org

ATTEMPT = UUID("0199f3a0-0000-7000-8000-000000000001")
AUDIENCE = "https://director-clipper.test"
# Footage the remote clipper only names: Cloud Run's stand-in never reads it.
ONE_SLICE = [ClipSlice(url="https://storage.test/s/0", startMs=0, durationMs=4_000)]


# ------------------------------------------------------------------------------ the rules


def test_speech_starts_where_a_silence_ends_and_stops_where_one_starts() -> None:
    log = (
        "[silencedetect @ 0x1] silence_start: -0.01\n"
        "[silencedetect @ 0x1] silence_end: 0.75 | silence_duration: 0.76\n"
        "[silencedetect @ 0x1] silence_start: 4.75\n"
        "[silencedetect @ 0x1] silence_end: 5.5 | silence_duration: 0.75\n"
    )
    # It opens in silence and closes on a silence: neither is where speech stops or starts.
    assert speech_in(log, Span(2_250, 7_750)) == Speech(onsets=[3_000], offsets=[7_000])


def test_a_cut_stays_between_the_pauses_around_its_start() -> None:
    def pause(start: int, end: int | None) -> ClipPause:
        return ClipPause(startMs=start, endMs=end)

    assert within_pauses(5_000, [], 20_000) == Span(0, 20_000)
    # A pause before, one after: the cut stays between them.
    assert within_pauses(5_000, [pause(1_000, 2_000), pause(8_000, 9_000)], 20_000) == Span(
        2_000, 8_000
    )
    # Paused and resumed at the same moment (the recorder held still): a wall all the same.
    assert within_pauses(5_000, [pause(5_000, 5_000)], 20_000) == Span(5_000, 20_000)
    # A start inside a pause moves to its end; one that never ended leaves nothing.
    assert within_pauses(5_000, [pause(4_000, 6_000)], 20_000) == Span(6_000, 20_000)
    assert within_pauses(5_000, [pause(4_000, None)], 20_000) == Span(20_000, 20_000)


def test_marks_snap_to_the_words_near_them_padded() -> None:
    speech = Speech(onsets=[1_000, 3_000], offsets=[2_000, 7_000])
    bounds = Span(0, 20_000)
    assert snap(Span(4_000, 6_000), speech, bounds) == Span(2_750, 7_250)
    # Nothing within reach: the marks stand.
    assert snap(Span(10_000, 12_000), speech, bounds) == Span(10_000, 12_000)
    # Two ends as near: the earlier.
    ends = Speech(onsets=[1_000], offsets=[3_500, 5_500])
    assert snap(Span(1_000, 4_500), ends, bounds) == Span(750, 3_750)


def test_a_start_snaps_to_the_earliest_word_within_reach() -> None:
    # A word just after the mark, and the take's first a second before it: Director marks
    # a start once it has heard it, so the first word in reach is where the take begins.
    speech = Speech(onsets=[4_000, 5_200], offsets=[9_000])
    assert snap(Span(5_000, 9_000), speech, Span(0, 20_000)).start_ms == 3_750


def test_an_unmarked_end_is_where_the_speaker_first_stops_for_a_while() -> None:
    # Words to 4 s, a short breath, words to 7 s, then two seconds of quiet before the chat.
    speech = Speech(onsets=[1_000, 4_500, 9_000], offsets=[4_000, 7_000, 15_000])
    assert first_pause_after(speech, 1_000, 61_000) == 7_000
    assert snap(Span(1_000, 61_000), speech, Span(0, 70_000), open_end=True) == Span(750, 7_250)
    # Speech that stops for good before the footage ends; none at all after the start.
    assert first_pause_after(Speech([1_000], [3_000]), 1_000, 3_500) == 3_000
    assert first_pause_after(Speech([1_000], [3_000]), 5_000, 9_000) is None
    # Speech that resumes after a breath runs on to where it next stops; speech that never
    # stops leaves the end where it was (at most a take long).
    chatter = Speech(onsets=[1_000, 3_500], offsets=[3_000, 5_500])
    assert first_pause_after(chatter, 1_000, 61_000) == 5_500
    assert first_pause_after(Speech([1_000, 3_500], [3_000]), 1_000, 61_000) is None


def test_a_recording_starts_with_its_declared_type_s_signature() -> None:
    webm = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81"
    mp4 = b"\x00\x00\x00\x20ftypisom"
    assert looks_like(webm, "video/webm")
    assert looks_like(mp4, "video/mp4")
    assert not looks_like(mp4, "video/webm")
    assert not looks_like(webm, "video/mp4")
    assert not looks_like(b"#EXTM3U\n#EXT-X-VERSION:3\n", "video/webm")
    assert not looks_like(b"", "video/mp4")


def test_ffmpeg_reads_the_declared_type_from_a_local_file_only() -> None:
    args = clipping.speech_args(Path("footage"), "video/mp4", Span(1_000, 2_000))
    flags = args[: args.index("-i") + 2]
    assert flags[-6:] == ["-threads", "2", "-f", "mov", "-i", "file:footage"]
    assert flags[flags.index("-protocol_whitelist") + 1] == "file"
    cut = clipping.cut_args(Path("footage"), "video/webm", Span(1_000, 2_000), Path("take"))
    assert cut[cut.index("-i") - 1] == "matroska"
    assert cut[-1] == "file:take"


# ---------------------------------------------------------------------------------- jail


def _jailed(command: list[str]) -> tuple[int | None, str]:
    code, stderr = asyncio.run(run_process([*clipping.JAIL, *command]))
    return code, stderr.decode(errors="replace")


# What a program run through the jail sees: its environment and limits.
_REPORT = (
    "import json, os, resource, sys; "
    "sys.stderr.write(json.dumps({'env': dict(os.environ), "
    "'cpu': resource.getrlimit(resource.RLIMIT_CPU)[0], "
    "'file': resource.getrlimit(resource.RLIMIT_FSIZE)[0], "
    "'core': resource.getrlimit(resource.RLIMIT_CORE)[0], 'nice': os.nice(0)}))"
)


class _Jailed(BaseModel):
    env: dict[str, str]
    cpu: int
    file: int
    core: int
    nice: int


def test_ffmpeg_runs_without_the_service_s_secrets_and_with_its_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import jail

    monkeypatch.setenv("AI_SERVICE_SECRET", "planted-secret")
    code, report = _jailed([sys.executable, "-c", _REPORT])
    assert code == 0, report
    seen = _Jailed.model_validate_json(report)
    assert "planted-secret" not in report
    assert seen.env["PATH"]
    assert not {"AI_SERVICE_SECRET", "DATABASE_URL", "REDIS_URL"} & set(seen.env)
    assert (seen.cpu, seen.file, seen.core) == (jail.CPU_SECONDS, jail.FILE_BYTES, 0)
    assert seen.nice >= jail.NICENESS


def test_a_program_the_jail_can_t_start_answers_the_shell_s_code() -> None:
    code, said = _jailed(["no-such-program-here"])
    assert (code, "can't start no-such-program-here" in said) == (clipping.CANNOT_START, True)


def test_a_snapped_cut_stays_in_its_bounds_and_a_take_long() -> None:
    speech = Speech(onsets=[3_000], offsets=[7_000])
    assert snap(Span(4_000, 6_000), speech, Span(2_900, 7_100)) == Span(2_900, 7_100)
    assert snap(Span(0, 90_000), Speech([], []), Span(0, 100_000)) == Span(0, MAX_CLIP_MS)


# ---------------------------------------------------------------------------- recordings


def _tool(args: list[str]) -> str:
    """Runs ffmpeg as the clipper does (app/process.py): what it logged, once it succeeded."""
    code, log = asyncio.run(run_process(args))
    assert code == 0, log.decode(errors="replace")
    return log.decode(errors="replace")


# A tone, standing in for speech, from 3 to 7 seconds and from 9 to 11, silence around it.
_TONE = "if(between(t,3,7)+between(t,9,11),0.4*sin(2*PI*440*t),0)"


def _record(path: Path, encoding: list[str]) -> bytes:
    """Twelve seconds of a test picture and _TONE, encoded as `encoding` says."""
    _ = _tool(
        [
            *("ffmpeg", "-hide_banner", "-loglevel", "error"),
            *("-f", "lavfi", "-i", "testsrc=size=360x640:rate=24:duration=12"),
            *("-f", "lavfi", "-i", f"aevalsrc='{_TONE}':s=48000:d=12"),
            *encoding,
            *("-shortest", str(path)),
        ]
    )
    return path.read_bytes()


@pytest.fixture(scope="module")
def recording(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    """Twelve seconds as Chrome's MediaRecorder writes them: VP8 and Opus in WebM, as a
    live stream, so with no duration and no index (Cues) to seek by."""
    path = tmp_path_factory.mktemp("recording") / "recording.webm"
    return _record(
        path, ["-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-f", "webm", "-live", "1"]
    )


@pytest.fixture(scope="module")
def safari_recording(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    """The same as Safari's MediaRecorder writes it: H.264 and AAC in fragmented MP4."""
    path = tmp_path_factory.mktemp("recording") / "recording.mp4"
    fragmented = "frag_keyframe+empty_moov+default_base_moof"
    return _record(path, ["-c:v", "libx264", "-c:a", "aac", "-movflags", fragmented])


def _pieces(data: bytes) -> dict[str, tuple[str, bytes]]:
    """The recording cut into three slices at arbitrary bytes, as a recorder's timeslices
    fall."""
    third = len(data) // 3
    pieces = [data[:third], data[third : 2 * third], data[2 * third :]]
    return {f"/s/{index}": ("video/webm", piece) for index, piece in enumerate(pieces)}


def _slices(url: str) -> list[ClipSlice]:
    """Presigned reads of the three slices, four seconds each."""
    return [
        ClipSlice(
            url=f"{url}/s/{index}?X-Amz-Signature=secret", startMs=index * 4_000, durationMs=4_000
        )
        for index in range(3)
    ]


def _request(slices: list[ClipSlice], start: int, end: int | None, **extra: object) -> ClipRequest:
    return ClipRequest.model_validate(
        {
            "attemptId": str(ATTEMPT),
            "contentType": "video/webm",
            "slices": [piece.model_dump() for piece in slices],
            "startMs": start,
            "endMs": end,
            "pauses": [],
            **extra,
        }
    )


def _duration_ms(video: bytes, tmp_path: Path) -> int:
    """How long a take plays, once it's shown to be H.264 and AAC in MP4."""
    path = tmp_path / "take.mp4"
    _ = path.write_bytes(video)
    log = _tool(["ffmpeg", "-hide_banner", "-i", str(path), "-f", "null", "-"])
    assert "Video: h264" in log, log
    assert "Audio: aac" in log, log
    found = re.search(r"Duration: (\d+):(\d+):([\d.]+)", log)
    assert found is not None, log
    hours, minutes, seconds = found.groups()
    return round(((int(hours) * 60 + int(minutes)) * 60 + float(seconds)) * 1000)


@pytest.fixture
def storage(recording: bytes) -> Iterator[tuple[Fake, list[ClipSlice]]]:
    with serve_files(_pieces(recording)) as served:
        yield served, _slices(served.url)


def _clip(request: ClipRequest, clipper: LocalClipper | None = None) -> Clip:
    async def run() -> Clip:
        async with httpx.AsyncClient() as http:
            return await (clipper or LocalClipper(http)).clip(request)

    return asyncio.run(run())


@pytest.mark.integration
def test_an_attempt_is_cut_from_its_first_word_to_its_last(
    storage: tuple[Fake, list[ClipSlice]], tmp_path: Path
) -> None:
    served, slices = storage
    clip = _clip(_request(slices, 4_000, 6_000))
    # The tone starts at 3 s and stops at 7 s: a quarter-second either side.
    assert abs(clip.start_ms - 2_750) <= 60, clip.start_ms
    assert abs(clip.end_ms - 7_250) <= 60, clip.end_ms
    assert abs(_duration_ms(clip.video, tmp_path) - (clip.end_ms - clip.start_ms)) <= 120
    # Every slice, from the first: only it holds the recording's header.
    assert [path.split("?")[0] for path, _ in served.received] == ["/s/0", "/s/1", "/s/2"]


@pytest.mark.integration
def test_an_attempt_recorded_in_safari_is_cut_the_same_way(
    safari_recording: bytes, tmp_path: Path
) -> None:
    pieces = {path: ("video/mp4", data) for path, (_, data) in _pieces(safari_recording).items()}
    with serve_files(pieces) as served:
        clip = _clip(_request(_slices(served.url), 4_000, 6_000, contentType="video/mp4"))
    # AAC's priming samples, which a fragmented MP4 has no edit list to skip, move the
    # sound a few dozen milliseconds later.
    assert abs(clip.start_ms - 2_750) <= 120, clip.start_ms
    assert abs(clip.end_ms - 7_250) <= 120, clip.end_ms
    assert _duration_ms(clip.video, tmp_path) > 4_000


@pytest.mark.integration
def test_footage_that_isn_t_the_recording_it_says_it_is_is_never_decoded() -> None:
    playlist = b"#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/computeMetadata/v1/\n"
    ran: list[list[str]] = []

    async def ffmpeg(args: list[str]) -> tuple[int | None, bytes]:
        ran.append(args)
        return 0, b""

    async def run(request: ClipRequest) -> Clip:
        async with httpx.AsyncClient() as http:
            return await LocalClipper(http, run=ffmpeg).clip(request)

    with serve_files({"/s/0": ("video/webm", playlist)}) as served:
        slices = [ClipSlice(url=f"{served.url}/s/0", startMs=0, durationMs=4_000)]
        with pytest.raises(ClipFailed) as refused:
            _ = asyncio.run(run(_request(slices, 1_000, 3_000)))
    assert (refused.value.retryable, ran) == (False, [])


@pytest.mark.integration
def test_one_attempt_is_cut_at_a_time(storage: tuple[Fake, list[ClipSlice]]) -> None:
    _, slices = storage
    running = 0
    most = 0

    async def ffmpeg(args: list[str]) -> tuple[int | None, bytes]:
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.01)
        running -= 1
        if "-y" in args:
            # The take a cut writes (finding speech writes nothing, and finds none).
            _ = await asyncio.to_thread(Path(args[-1].removeprefix("file:")).write_bytes, b"mp4")
        return 0, b""

    async def run() -> list[Clip]:
        async with httpx.AsyncClient() as http:
            clipper = LocalClipper(http, run=ffmpeg)
            return await asyncio.gather(
                *(clipper.clip(_request(slices, 1_000, 3_000)) for _ in range(3))
            )

    assert [clip.video for clip in asyncio.run(run())] == [b"mp4"] * 3
    assert most == 1


@pytest.mark.integration
def test_an_attempt_never_runs_across_a_pause(storage: tuple[Fake, list[ClipSlice]]) -> None:
    _, slices = storage
    pause = {"startMs": 5_000, "endMs": 5_000}
    clip = _clip(_request(slices, 4_000, 6_000, pauses=[pause]))
    assert (abs(clip.start_ms - 2_750) <= 60, clip.end_ms) == (True, 5_000)


@pytest.mark.integration
def test_an_attempt_left_open_ends_where_the_speaker_stops(
    storage: tuple[Fake, list[ClipSlice]],
) -> None:
    _, slices = storage
    clip = _clip(_request(slices, 8_500, None))
    assert abs(clip.start_ms - 8_750) <= 60
    # The footage ends at 12 s, the last word at 11 s.
    assert abs(clip.end_ms - 11_250) <= 60
    # Two seconds of quiet after the first stretch of speech: the take ends there, not
    # with what's said after.
    first = _clip(_request(slices, 3_500, None))
    assert abs(first.end_ms - 7_250) <= 60, first.end_ms


@pytest.mark.integration
def test_marks_with_no_sound_to_read_stand(tmp_path: Path) -> None:
    silent = tmp_path / "silent.webm"
    _ = _tool(
        [
            *("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi"),
            *("-i", "testsrc=size=320x240:rate=24:duration=4", "-c:v", "libvpx", str(silent)),
        ]
    )
    with serve_files({"/s/0": ("video/webm", silent.read_bytes())}) as served:
        slices = [ClipSlice(url=f"{served.url}/s/0", startMs=0, durationMs=4_000)]
        clip = _clip(_request(slices, 1_000, 3_000))
    assert (clip.start_ms, clip.end_ms) == (1_000, 3_000)


@pytest.mark.integration
def test_what_can_t_be_cut_fails_for_good(storage: tuple[Fake, list[ClipSlice]]) -> None:
    _, slices = storage
    with pytest.raises(ClipFailed) as backwards:
        _ = _clip(_request(slices, 1_000, 900))
    assert not backwards.value.retryable
    # Marks after the speech ended, the end snapping back past the start.
    with pytest.raises(ClipFailed) as snapped_away:
        _ = _clip(_request(slices, 7_400, 8_000))
    assert not snapped_away.value.retryable
    # Started in a pause that never ended: nothing was recorded after it.
    never_resumed = {"startMs": 3_000, "endMs": None}
    with pytest.raises(ClipFailed) as paused:
        _ = _clip(_request(slices, 4_000, 6_000, pauses=[never_resumed]))
    assert not paused.value.retryable

    async def broken(_args: list[str]) -> tuple[int | None, bytes]:
        return 1, b"Invalid data found when processing input"

    async def run() -> Clip:
        async with httpx.AsyncClient() as http:
            return await LocalClipper(http, run=broken).clip(_request(slices, 4_000, 6_000))

    with pytest.raises(ClipFailed) as unreadable:
        _ = asyncio.run(run())
    assert not unreadable.value.retryable


@pytest.mark.integration
def test_too_much_footage_or_too_large_a_take_fails_for_good(
    storage: tuple[Fake, list[ClipSlice]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, slices = storage
    monkeypatch.setattr(clipping, "MAX_CLIP_BYTES", 1_000)
    with pytest.raises(ClipFailed) as large:
        _ = _clip(_request(slices, 4_000, 6_000))
    assert not large.value.retryable
    monkeypatch.setattr(clipping, "MAX_FOOTAGE_BYTES", 10)
    with pytest.raises(ClipFailed) as footage:
        _ = _clip(_request(slices, 4_000, 6_000))
    assert not footage.value.retryable


@pytest.mark.integration
def test_footage_out_of_reach_or_ffmpeg_missing_is_worth_another_try(
    storage: tuple[Fake, list[ClipSlice]], monkeypatch: pytest.MonkeyPatch
) -> None:
    _, slices = storage
    gone = [slices[0].model_copy(update={"url": slices[0].url.replace("/s/0", "/gone")})]
    with pytest.raises(ClipFailed) as unreachable:
        _ = _clip(_request(gone, 1_000, 3_000))
    assert unreachable.value.retryable
    assert "secret" not in str(unreachable.value)

    async def missing(_args: list[str]) -> tuple[int | None, bytes]:
        raise FileNotFoundError("python")

    async def no_ffmpeg_here(_args: list[str]) -> tuple[int | None, bytes]:
        return clipping.CANNOT_START, b"jail: can't start ffmpeg"

    async def hangs(_args: list[str]) -> tuple[int | None, bytes]:
        await asyncio.sleep(5)
        return 0, b""

    async def run(runner: clipping.Runner) -> Clip:
        async with httpx.AsyncClient() as http:
            return await LocalClipper(http, run=runner).clip(_request(slices, 4_000, 6_000))

    with pytest.raises(ClipFailed) as no_python:
        _ = asyncio.run(run(missing))
    assert no_python.value.retryable
    with pytest.raises(ClipFailed) as no_ffmpeg:
        _ = asyncio.run(run(no_ffmpeg_here))
    assert no_ffmpeg.value.retryable
    monkeypatch.setattr(clipping, "FFMPEG_SECONDS", 0.05)
    with pytest.raises(ClipFailed) as slow:
        _ = asyncio.run(run(hangs))
    assert not slow.value.retryable


# ------------------------------------------------------------------- the AI service's route


@pytest.mark.integration
def test_the_service_cuts_an_attempt_for_its_caller(
    client: TestClient, storage: tuple[Fake, list[ClipSlice]], tmp_path: Path
) -> None:
    _, slices = storage
    org, user = new_org()
    body = _request(slices, 4_000, 6_000).model_dump(mode="json")
    response = client.post("/v1/director/clips", json=body, headers=headers(org, user))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "video/mp4"
    start, end = int(response.headers["x-clip-start-ms"]), int(response.headers["x-clip-end-ms"])
    assert abs(start - 2_750) <= 60
    assert abs(end - 7_250) <= 60
    assert _duration_ms(response.content, tmp_path) > 4_000

    failed = client.post(
        "/v1/director/clips",
        json={**body, "startMs": 1_000, "endMs": 900},
        headers=headers(org, user),
    )
    assert (failed.status_code, error_of(failed).code) == (422, "RECORDING_CLIP_FAILED")
    gone = {
        **body,
        "startMs": 1_000,
        "endMs": 3_000,
        "slices": [{**body["slices"][0], "url": "http://127.0.0.1:9/gone"}],
    }
    unreachable = client.post("/v1/director/clips", json=gone, headers=headers(org, user))
    assert (unreachable.status_code, error_of(unreachable).code) == (502, "UPSTREAM_UNAVAILABLE")
    anonymous = client.post("/v1/director/clips", json=body)
    assert anonymous.status_code == 401


# ------------------------------------------------------------------- the Cloud Run clipper


@pytest.fixture
def identity() -> Iterator[Identity]:
    with serve_identity() as found:
        yield found


@pytest.fixture
def clipper(monkeypatch: pytest.MonkeyPatch, identity: Identity) -> Iterator[TestClient]:
    for key, value in {
        "NODE_ENV": "test",
        "CLIPPER_URL": AUDIENCE,
        "CLIPPER_INVOKER": identity.service_account,
        "GOOGLE_CERTS_URL": f"{identity.url}{CERTS_PATH}",
    }.items():
        monkeypatch.setenv(key, value)
    get_clipper_settings.cache_clear()
    from app.clipper import app

    with TestClient(app) as test_client:
        yield test_client
    get_clipper_settings.cache_clear()


@pytest.mark.integration
def test_the_clipper_cuts_for_the_account_that_may_call_it(
    clipper: TestClient, identity: Identity, storage: tuple[Fake, list[ClipSlice]]
) -> None:
    _, slices = storage
    body = _request(slices, 4_000, 6_000).model_dump(mode="json")
    assert clipper.get("/health/live").json() == {"status": "ok"}
    for path in ("/openapi.json", "/docs"):
        assert clipper.get(path).status_code == 404

    def call(authorization: str | None) -> int:
        sent = {"authorization": authorization} if authorization else {}
        return clipper.post("/v1/clip", json=body, headers=sent).status_code

    assert call(None) == 401
    assert call(f"Bearer {identity.token('https://elsewhere.test')}") == 401
    someone = identity.token(AUDIENCE, email="someone@test-project.iam.gserviceaccount.com")
    assert call(f"Bearer {someone}") == 403
    response = clipper.post(
        "/v1/clip", json=body, headers={"authorization": f"Bearer {identity.token(AUDIENCE)}"}
    )
    assert response.status_code == 200, response.text
    assert abs(int(response.headers["x-clip-start-ms"]) - 2_750) <= 60


def test_the_clipper_refuses_plain_http_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("CLIPPER_URL", "http://director-clipper.test")
    monkeypatch.setenv("CLIPPER_INVOKER", "vm@project.iam.gserviceaccount.com")
    get_clipper_settings.cache_clear()
    with pytest.raises(ValueError, match="HTTPS in production"):
        _ = get_clipper_settings()
    get_clipper_settings.cache_clear()


# --------------------------------------------------------------- reaching it from the VM


type Answer = tuple[int, dict[str, str], bytes]


@pytest.fixture
def cloud_run() -> Iterator[tuple[str, list[Answer], list[str]]]:
    """The clipper as Cloud Run fronts it: answers in turn, and who asked."""
    answers: list[Answer] = []
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            _ = self.rfile.read(int(self.headers.get("content-length", "0")))
            seen.append(self.headers.get("authorization", ""))
            status, sent, data = answers.pop(0)
            self.send_response(status)
            for name, value in sent.items():
                self.send_header(name, value)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            _ = self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", answers, seen
    finally:
        server.shutdown()


def _error(code: str, status: int) -> bytes:
    return json.dumps(
        {"defined": True, "code": code, "status": status, "message": code, "data": {"params": {}}}
    ).encode()


@pytest.mark.integration
def test_the_remote_clipper_calls_cloud_run_as_the_vm(
    cloud_run: tuple[str, list[Answer], list[str]],
    identity: Identity,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url, answers, seen = cloud_run
    monkeypatch.setenv("GCE_METADATA_HOST", identity.host)
    request = _request(
        [ClipSlice(url="https://storage.test/s/0", startMs=0, durationMs=4_000)], 0, 3_000
    )
    mp4 = {"content-type": "video/mp4"}
    answers.extend(
        [
            (200, {**mp4, "x-clip-start-ms": "250", "x-clip-end-ms": "3250"}, b"mp4"),
            (200, mp4, b"mp4"),
            (422, {"content-type": "application/json"}, _error("RECORDING_CLIP_FAILED", 422)),
            (502, {"content-type": "application/json"}, _error("UPSTREAM_UNAVAILABLE", 502)),
            (403, {"content-type": "text/html"}, b"<h1>Forbidden</h1>"),
        ]
    )

    async def clip() -> Clip:
        async with httpx.AsyncClient() as http:
            return await RemoteClipper(url, http).clip(request)

    assert asyncio.run(clip()) == Clip(video=b"mp4", start_ms=250, end_ms=3_250)
    assert seen[0].startswith("Bearer ey")
    outcomes: list[bool] = []
    for _ in range(4):
        with pytest.raises(ClipFailed) as failed:
            _ = asyncio.run(clip())
        outcomes.append(failed.value.retryable)
    # Unreadable answer, the clipper's refusal, an outage, Cloud Run's IAM refusing.
    assert outcomes == [False, False, True, False]


@pytest.mark.integration
def test_a_clipper_out_of_reach_is_worth_another_try(
    identity: Identity, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GCE_METADATA_HOST", identity.host)
    request = _request(
        [ClipSlice(url="https://storage.test/s/0", startMs=0, durationMs=4_000)], 0, 3_000
    )

    async def clip() -> Clip:
        async with httpx.AsyncClient() as http:
            # Nothing listens on port 9: the connection is refused.
            return await RemoteClipper("http://127.0.0.1:9", http).clip(request)

    with pytest.raises(ClipFailed) as failed:
        _ = asyncio.run(clip())
    assert failed.value.retryable


def test_the_clipper_s_services_exist_only_while_it_runs() -> None:
    from app.clipper import services

    with pytest.raises(RuntimeError, match="isn't started"):
        _ = services()
