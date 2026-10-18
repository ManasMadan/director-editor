"""Lining up a match cut (app/aligning.py, app/aligner.py) on real footage: synthetic
clips written as MP4 files (tests/match_cut_videos.py), read through ffmpeg and aligned
with OpenCV, with Gemini's boxes from the local Gemini API (tests/fakes.py). The tests
that run ffmpeg are marked integration, as the clipper's are: the unit run has none."""

import asyncio
import base64
import math
import socket
from collections.abc import Callable, Iterator
from pathlib import Path

import cv2
import httpx
import httpx2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import aligning as aligning_module
from app.aligner import services
from app.aligning import (
    FPS,
    LocalAligner,
    Patch,
    RemoteAligner,
    Similarity,
    aligning,
    apply,
    create_locator,
    frame_command,
    jpeg,
    match,
    patch_of,
    pick_cut,
    read_frames,
    refine,
    seed_warp,
    similarity,
    uncovered,
    within_tolerance,
)
from app.clipping import JAIL
from app.director import create_google_model
from app.errors import AppError
from app.schemas import (
    AlignRequest,
    AlignResult,
    Box,
    MatchCutAlignment,
    MatchCutTransform,
    TakeVideoType,
    TokenUsage,
)
from app.settings import GeminiSettings, get_aligner_settings
from tests.fakes import (
    CERTS_PATH,
    GEMINI_MODEL,
    GEMINI_PATH,
    Fake,
    Identity,
    Reply,
    gemini_error,
    gemini_output,
    serve,
    serve_files,
    serve_identity,
)
from tests.match_cut_videos import HEIGHT, WIDTH, Placement, output_box, write_clip
from tests.support import error_of

# The take's pixels in the finished video's 720x1280 frame (the takes are already 9:16).
TO_OUTPUT = 720 / WIDTH
AUDIENCE = "https://director-aligner.test"
SECONDS = 1.5
LAST = round(SECONDS * 30) - 1


def _output(placement: Placement, frame: int = 0) -> tuple[float, float]:
    return (
        (placement.x + placement.vx * frame) * TO_OUTPUT,
        (placement.y + placement.vy * frame) * TO_OUTPUT,
    )


def _moved(transform: MatchCutTransform, point: tuple[float, float]) -> tuple[float, float]:
    """Where the transform draws `point` of the incoming frame (the renderer's maths)."""
    angle = math.radians(transform.rotation)
    cos, sin = transform.scale * math.cos(angle), transform.scale * math.sin(angle)
    x, y = point[0] - 360, point[1] - 640
    return 360 + cos * x - sin * y + transform.x, 640 + sin * x + cos * y + transform.y


def _sightings(
    before: dict[str, float] | None, after: dict[str, float] | None
) -> dict[str, object]:
    """Gemini's answer: each box as four numbers, all null when the anchor isn't seen."""
    nothing: dict[str, float | None] = dict.fromkeys(("x", "y", "width", "height"))

    def seen(box: dict[str, float] | None) -> dict[str, object]:
        return {"visible": box is not None, **(nothing if box is None else box)}

    return {"before": seen(before), "after": seen(after)}


def _off(box: dict[str, float], dx: float, dy: float) -> dict[str, float]:
    """Gemini's box, a little off: it boxes the watch roughly, never to the pixel."""
    return {**box, "x": box["x"] + dx, "y": box["y"] + dy}


def _gemini_settings(fake: Fake) -> GeminiSettings:
    return GeminiSettings.model_validate(
        {"GOOGLE_API_KEY": "test-key", "GOOGLE_BASE_URL": fake.url, "GOOGLE_VERTEX": False}
    )


@pytest.fixture
def clips(tmp_path: Path) -> Callable[[Placement, Placement], dict[str, tuple[str, bytes]]]:
    def make(outgoing: Placement, incoming: Placement) -> dict[str, tuple[str, bytes]]:
        a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
        write_clip(a, 1, outgoing, SECONDS)
        write_clip(b, 2, incoming, SECONDS)
        return {"/a.mp4": ("video/mp4", a.read_bytes()), "/b.mp4": ("video/mp4", b.read_bytes())}

    return make


def _request(storage: Fake, max_tokens: int = 12_000) -> AlignRequest:
    return AlignRequest.model_validate(
        {
            "anchor": "the watch on the left wrist",
            "outgoing": {"url": f"{storage.url}/a.mp4?sig=secret", "atMs": 1500},
            "incoming": {"url": f"{storage.url}/b.mp4?sig=secret", "atMs": 0},
            "maxTokens": max_tokens,
        }
    )


def _align(
    files: dict[str, tuple[str, bytes]], sightings: dict[str, object]
) -> tuple[AlignResult, Fake]:
    with (
        serve({GEMINI_PATH: gemini_output(sightings, tokens=1_200)}) as gemini,
        serve_files(files) as storage,
    ):
        model = create_google_model(_gemini_settings(gemini), GEMINI_MODEL)
        result = asyncio.run(LocalAligner(create_locator(model)).align(_request(storage)))
        return result, gemini


# ------------------------------------------------------------------------ acceptance


@pytest.mark.integration
def test_a_wrist_60_px_off_lines_up_within_tolerance(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    """Spec 9.5: the wrist moved 60 px off on purpose (and a little closer, a little
    turned) still gives a cut where the watch moves at most 8 px."""
    outgoing = Placement(270, 480)
    # 45 and 30 take pixels: 60 and 40 in the finished frame, 72 px in all.
    incoming = Placement(315, 450, scale=1.06, rotation=2.5)
    files = clips(outgoing, incoming)
    sightings = _sightings(
        _off(output_box(outgoing, LAST), 0.01, -0.008), _off(output_box(incoming, 0), -0.012, 0.01)
    )
    result, gemini = _align(files, sightings)
    alignment = result.alignment

    assert alignment.status == "aligned"
    # The anchor really lands where it was, checked against where it was drawn.
    landed = _moved(alignment.transform, _output(incoming))
    target = _output(outgoing, LAST)
    assert math.dist(landed, target) <= 8
    assert abs(alignment.transform.scale * incoming.scale - 1) <= 0.03
    assert abs(alignment.transform.rotation + incoming.rotation) <= 1.5
    # What "Check the cut" shows: the jump before, what's left after.
    assert alignment.offsetBeforePx == pytest.approx(72, abs=4)
    assert alignment.offsetPx <= 8
    assert alignment.withinTolerance
    assert alignment.anchor is not None
    assert alignment.anchor.x == pytest.approx(target[0] / 720, abs=0.02)
    # Both still: the cut stays where it was asked.
    assert (alignment.outgoingEndMs, alignment.incomingStartMs) == (1500, 0)
    assert 0 < alignment.cropPercent < 20
    for frame in (alignment.outgoingFrame, alignment.incomingFrame):
        assert frame is not None
        assert base64.b64decode(frame)[:2] == b"\xff\xd8"
    assert (result.usage.inputTokens, result.usage.outputTokens) == (1_100, 100)
    # Gemini saw the two boundary frames, and the anchor named.
    [(_, sent)] = gemini.received
    assert sent.count(b"image/jpeg") == 2
    assert b"the watch on the left wrist" in sent


@pytest.mark.integration
def test_a_wrist_held_still_in_both_is_cut_where_asked(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    still = Placement(270, 480)
    files = clips(still, still)
    result, _ = _align(files, _sightings(output_box(still, LAST), output_box(still, 0)))
    assert (result.alignment.outgoingEndMs, result.alignment.incomingStartMs) == (1500, 0)
    assert result.alignment.offsetBeforePx <= 2


@pytest.mark.integration
def test_an_anchor_gemini_cant_see_is_a_plain_cut(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    files = clips(Placement(270, 480), Placement(300, 480))
    result, _ = _align(files, _sightings(output_box(Placement(270, 480), LAST), None))
    assert result.alignment == MatchCutAlignment(
        status="not-found",
        outgoingEndMs=1500,
        incomingStartMs=0,
        transform=MatchCutTransform(x=0, y=0, scale=1, rotation=0),
        offsetBeforePx=0,
        offsetPx=0,
        scaleDiff=0,
        rotationDiff=0,
        cropPercent=0,
        withinTolerance=False,
        anchor=None,
        outgoingFrame=None,
        incomingFrame=None,
    )


@pytest.mark.integration
def test_a_box_on_something_else_is_a_plain_cut(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    """Gemini boxed the watch before the cut, but after it boxed bare background: nothing
    there looks like the watch, so nothing is moved."""
    outgoing = Placement(270, 480)
    files = clips(outgoing, Placement(100, 150))
    elsewhere = {"x": 0.6, "y": 0.75, "width": 0.17, "height": 0.09}
    result, _ = _align(files, _sightings(output_box(outgoing, LAST), elsewhere))
    assert result.alignment.status == "not-found"


@pytest.mark.integration
@pytest.mark.parametrize(
    "box",
    [
        # A box with an edge missing, or one that isn't inside the frame.
        {"x": 0.4, "y": 0.4, "width": 0.2, "height": None},
        {"x": 0.4, "y": 1.4, "width": 0.2, "height": 0.1},
        {"x": 0.4, "y": 0.4, "width": 0, "height": 0.1},
    ],
)
def test_a_box_that_isnt_one_is_a_plain_cut(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
    box: dict[str, float | None],
) -> None:
    still = Placement(270, 480)
    files = clips(still, still)
    sightings = _sightings(output_box(still, LAST), output_box(still, 0))
    sightings["after"] = {"visible": True, **box}
    result, _ = _align(files, sightings)
    assert result.alignment.status == "not-found"


@pytest.mark.integration
def test_gemini_failing_is_upstream_unavailable_with_what_it_used(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    files = clips(Placement(270, 480), Placement(270, 480))
    with (
        serve({GEMINI_PATH: gemini_error(500, "INTERNAL")}) as gemini,
        serve_files(files) as storage,
    ):
        model = create_google_model(_gemini_settings(gemini), GEMINI_MODEL)
        with pytest.raises(AppError) as raised:
            asyncio.run(LocalAligner(create_locator(model)).align(_request(storage)))
    assert raised.value.code == "UPSTREAM_UNAVAILABLE"
    assert raised.value.params["service"] == "gemini"


@pytest.mark.integration
def test_a_take_that_cant_be_read_is_upstream_unavailable() -> None:
    with serve_files({}) as storage, pytest.raises(AppError) as raised:
        asyncio.run(read_frames(f"{storage.url}/gone.mp4?sig=secret", "video/mp4", 0, 0.5))
    assert (raised.value.code, raised.value.params) == (
        "UPSTREAM_UNAVAILABLE",
        {"service": "storage"},
    )


@pytest.mark.integration
def test_frames_are_fitted_to_the_finished_frame(tmp_path: Path) -> None:
    path = tmp_path / "a.mp4"
    write_clip(path, 1, Placement(270, 480), 1.0)
    with serve_files({"/a.mp4": ("video/mp4", path.read_bytes())}) as storage:
        frames = asyncio.run(read_frames(f"{storage.url}/a.mp4", "video/mp4", 0.5, 0.5))
    assert len(frames) == round(0.5 * FPS)
    assert frames[0].shape == (640, 360, 3)
    assert (WIDTH, HEIGHT) == (540, 960)


def test_ffmpeg_reads_a_take_in_the_jail_as_its_type_over_its_url_s_protocol_only() -> None:
    """A member's take is decoded with no secrets and bounded resources (app/jail.py), as
    the type it was stored as, never probed, and from its presigned URL's protocol alone."""
    url = "https://storage.googleapis.com/bucket/files/1?X-Goog-Signature=abc"
    command = frame_command(url, "video/webm", 1.0, 0.5)
    assert command[: len(JAIL)] == JAIL
    assert command[len(JAIL)] == "ffmpeg"
    for flag, value in [("-protocol_whitelist", "https,tls,tcp"), ("-f", "matroska"), ("-i", url)]:
        assert command[command.index(flag) + 1] == value
    assert command.index("-protocol_whitelist") < command.index("-i")
    assert command.index("-f") < command.index("-i")
    plain = frame_command("http://127.0.0.1:9000/files/1", "video/mp4", 0, 0.5)
    assert plain[plain.index("-protocol_whitelist") + 1] == "http,tcp"
    assert plain[plain.index("-f") + 1] == "mov"


@pytest.mark.integration
def test_a_take_that_isn_t_its_type_or_isn_t_in_storage_is_never_read(tmp_path: Path) -> None:
    path = tmp_path / "a.mp4"
    write_clip(path, 1, Placement(270, 480), 1.0)
    playlist = b"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n"
    with serve_files(
        {"/a.mp4": ("video/mp4", path.read_bytes()), "/list.mp4": ("video/mp4", playlist)}
    ) as storage:
        tries: list[tuple[str, TakeVideoType]] = [
            # An MP4 said to be a WebM: read as one, it's nothing.
            (f"{storage.url}/a.mp4", "video/webm"),
            # A playlist dressed as a take: never opened as one, so nothing it names is.
            (f"{storage.url}/list.mp4", "video/mp4"),
            # Anything but the storage's own URL.
            (str(path), "video/mp4"),
            (f"file:{path}", "video/mp4"),
        ]
        for url, content_type in tries:
            with pytest.raises(AppError) as raised:
                asyncio.run(read_frames(url, content_type, 0, 0.5))
            assert raised.value.code == "UPSTREAM_UNAVAILABLE", url


# ------------------------------------------------------------------------ the maths


def test_within_tolerance_is_the_specs() -> None:
    assert within_tolerance(8, 0.03, 1.5)
    assert within_tolerance(0, 0, -1.5)
    assert not within_tolerance(8.1, 0, 0)
    assert not within_tolerance(0, 0.031, 0)
    assert not within_tolerance(0, 0, -1.6)


def test_aligning_puts_the_anchor_where_it_was() -> None:
    transform = aligning((180, 320), (200, 300), 1.1, math.radians(4))
    x, y = apply(transform.matrix(), 200, 300)
    assert (x, y) == (pytest.approx(180, abs=1e-3), pytest.approx(320, abs=1e-3))
    assert transform.scale == pytest.approx(1 / 1.1)
    assert transform.rotation == pytest.approx(math.radians(-4))


def test_uncovered_is_the_widest_gap_at_an_edge() -> None:
    assert uncovered(Similarity(scale=1, rotation=0, x=0, y=0)) == 0
    assert uncovered(Similarity(scale=1, rotation=0, x=36, y=0)) == pytest.approx(0.1)
    assert uncovered(Similarity(scale=1, rotation=0, x=0, y=-64)) == pytest.approx(0.1)
    assert uncovered(Similarity(scale=2, rotation=0, x=0, y=0)) == 0


def test_the_cut_lands_where_the_motion_matches() -> None:
    still = [(100.0, 100.0)] * 4
    # Both still: no trimming.
    assert pick_cut(still, still) == (3, 0)
    # The outgoing wrist moves 6 px a frame at its very end, the incoming starts still:
    # end before the move.
    moving_end = [(100.0, 100.0), (100.0, 100.0), (106.0, 100.0), (112.0, 100.0)]
    assert pick_cut(moving_end, still) == (1, 0)
    # The incoming one moves the same way at the same speed: cut where it is.
    moving_start = [(100.0, 100.0), (106.0, 100.0), (112.0, 100.0), (118.0, 100.0)]
    assert pick_cut(moving_end, moving_start) == (3, 0)
    # One frame each side.
    assert pick_cut([(1.0, 1.0)], [(2.0, 2.0)]) == (0, 0)


# ------------------------------------------------------------------------ remote


def test_the_remote_aligner_sends_the_cut_with_an_id_token(
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answer = AlignResult(
        alignment=MatchCutAlignment(
            status="not-found",
            outgoingEndMs=1500,
            incomingStartMs=0,
            transform=MatchCutTransform(x=0, y=0, scale=1, rotation=0),
            offsetBeforePx=0,
            offsetPx=0,
            scaleDiff=0,
            rotationDiff=0,
            cropPercent=0,
            withinTolerance=False,
            anchor=None,
            outgoingFrame=None,
            incomingFrame=None,
        ),
        usage=TokenUsage(inputTokens=10, outputTokens=2),
    )
    with serve_identity() as identity:
        monkeypatch.setenv("GCE_METADATA_HOST", identity.host)
        with (
            serve({"/v1/align": lambda _body: (200, answer.model_dump(mode="json"))}) as aligner,
            serve_files({}) as storage,
        ):
            result = asyncio.run(_remote(aligner.url).align(_request(storage)))
            assert result == answer
            # An ID token for the aligner's own URL, from the metadata server.
            assert (aligner.authorizations[0] or "").startswith("Bearer ey")
            assert any("audience=" in path for path in identity.requests)

            # An answer it can't read, a refusal and no answer at all count the whole
            # reservation.
            replies: list[Reply] = [(200, {"nope": True}), (500, {"code": "INTERNAL"})]
            for reply in replies:
                with serve({"/v1/align": _answer(reply)}) as broken:
                    with pytest.raises(AppError) as raised:
                        asyncio.run(_remote(broken.url).align(_request(storage)))
                    assert raised.value.params == {
                        "service": "aligner",
                        "inputTokens": 12_000,
                        "outputTokens": 0,
                    }
            with pytest.raises(AppError):
                asyncio.run(_remote("http://127.0.0.1:9").align(_request(storage)))


def _answer(reply: Reply) -> Callable[[bytes], Reply]:
    return lambda _body: reply


def _remote(url: str) -> RemoteAligner:
    return RemoteAligner(url, httpx.AsyncClient())


# ------------------------------------------------------------------------ Cloud Run


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    handlers: dict[str, Callable[[bytes], Reply]] = {}
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def identity() -> Iterator[Identity]:
    with serve_identity() as found:
        yield found


@pytest.fixture
def cloud_run(
    monkeypatch: pytest.MonkeyPatch,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    identity: Identity,
) -> Iterator[TestClient]:
    env = {
        "NODE_ENV": "test",
        "ALIGNER_URL": AUDIENCE,
        "ALIGNER_INVOKER": identity.service_account,
        "GOOGLE_CERTS_URL": f"{identity.url}{CERTS_PATH}",
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
        "GOOGLE_VERTEX": "false",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_aligner_settings.cache_clear()
    from app.aligner import app

    with TestClient(app) as test_client:
        yield test_client
    get_aligner_settings.cache_clear()


@pytest.mark.integration
def test_the_cloud_run_aligner_lines_up_a_cut_for_the_account_that_may_call_it(
    cloud_run: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    clips: Callable[[Placement, Placement], dict[str, tuple[str, bytes]]],
) -> None:
    assert cloud_run.get("/health/live").json() == {"status": "ok"}
    for path in ("/openapi.json", "/docs"):
        assert cloud_run.get(path).status_code == 404
    still = Placement(270, 480)
    gemini[1][GEMINI_PATH] = gemini_output(
        _sightings(output_box(still, LAST), output_box(still, 0))
    )
    with serve_files(clips(still, still)) as storage:
        request = _request(storage).model_dump(mode="json")

        def call(authorization: str | None) -> httpx2.Response:
            headers = {"authorization": authorization} if authorization else {}
            return cloud_run.post("/v1/align", json=request, headers=headers)

        assert call(None).status_code == 401
        someone = identity.token(AUDIENCE, email="someone@test-project.iam.gserviceaccount.com")
        assert error_of(call(f"Bearer {someone}")).code == "FORBIDDEN"
        response = call(f"Bearer {identity.token(AUDIENCE)}")
    assert response.status_code == 200, response.text
    assert AlignResult.model_validate_json(response.content).alignment.status == "aligned"


@pytest.mark.integration
def test_a_read_given_up_on_stops_its_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    """A read that takes too long, or that's cancelled (the other take's read failed), has
    its ffmpeg killed, not left waiting on storage."""
    hung = socket.create_server(("127.0.0.1", 0))
    url = f"http://127.0.0.1:{hung.getsockname()[1]}/a.mp4"

    async def give_up() -> None:
        _ = await asyncio.wait_for(read_frames(url, "video/mp4", 0, 0.5), 1.0)

    try:
        with pytest.raises(TimeoutError):
            asyncio.run(give_up())
        monkeypatch.setattr(aligning_module, "FFMPEG_SECONDS", 0.2)
        with pytest.raises(AppError) as raised:
            asyncio.run(read_frames(url, "video/mp4", 0, 0.5))
        assert raised.value.code == "UPSTREAM_UNAVAILABLE"
    finally:
        hung.close()


# ------------------------------------------------------------------------ the pieces

# The working frame's size (app/aligning.py), smaller than the finished one.
WORK_WIDTH, WORK_HEIGHT = aligning_module.WIDTH, aligning_module.HEIGHT


def textured() -> np.ndarray[tuple[int, int], np.dtype[np.float32]]:
    """A working-size gray frame with texture everywhere, for matching to lock on to."""
    noise = np.random.default_rng(1).random((WORK_HEIGHT, WORK_WIDTH), dtype=np.float32)
    return np.asarray(cv2.GaussianBlur(noise * 255, (9, 9), 3), dtype=np.float32)


def test_the_aligner_s_services_exist_only_while_it_runs() -> None:
    with pytest.raises(RuntimeError, match="isn't started"):
        _ = services()


def test_a_frame_too_big_to_encode_is_refused() -> None:
    with pytest.raises(ValueError, match="couldn't be encoded"):
        _ = jpeg(np.zeros((70_000, 1, 3), dtype=np.uint8))


def test_a_patch_too_big_to_grow_is_matched_at_the_sizes_that_fit() -> None:
    frame = textured()
    width, height = WORK_WIDTH - 10, WORK_HEIGHT - 10
    patch = Patch(frame[:height, :width].copy(), 0, 0, width, height)
    warp, score = match(patch, frame, None, 1.0)
    assert score == pytest.approx(1, abs=1e-3)
    assert apply(warp, 0, 0) == (pytest.approx(0), pytest.approx(0))


def test_a_sighting_at_the_edge_searches_the_whole_frame() -> None:
    frame = textured()
    patch = patch_of(frame, Box(x=0.4, y=0.4, width=0.3, height=0.3))
    # Gemini's box runs off the frame's corner, so no window around it fits the patch.
    off_the_edge = Box(x=1, y=1, width=1, height=1)
    warp, score = match(patch, frame, off_the_edge, 1.0)
    assert score == pytest.approx(1, abs=1e-3)
    assert apply(warp, 0, 0) == (pytest.approx(patch.x), pytest.approx(patch.y))


def test_refining_keeps_the_seed_when_ecc_can_t_help() -> None:
    frame = textured()
    patch = patch_of(frame, Box(x=0.45, y=0.45, width=0.05, height=0.05))
    seed = seed_warp(1, patch.x, patch.y)
    # A blank frame: nothing to converge on.
    blank = np.zeros((WORK_HEIGHT, WORK_WIDTH), dtype=np.float32)
    assert np.array_equal(refine(patch, blank, seed), seed)
    # The patch three times its size in the frame: ECC finds it, but that's no scale a
    # phone moves by between takes.
    tripled = cv2.resize(patch.pixels, (patch.width * 3, patch.height * 3))
    zoomed = frame.copy()
    zoomed[100 : 100 + patch.height * 3, 50 : 50 + patch.width * 3] = tripled
    seed = seed_warp(3, 50, 100)
    assert np.array_equal(refine(patch, zoomed, seed), seed)
    assert similarity(seed)[0] == pytest.approx(3)
