"""Aligning a match cut: the anchor (a wrist with a watch) stays on the same spot while the
world changes between two clips (the redesign spec's 9.5).

1. ffmpeg reads the outgoing clip's last half second and the incoming clip's first, at
   15 frames a second, each frame fitted to the finished video's 9:16 frame as the
   browser's renderer does (covering it, cropped in the middle), at half its size.
2. Gemini locates the anchor in the two boundary frames (a box in each).
3. OpenCV refines that: multi-scale template matching seeds enhanced correlation
   alignment (ECC) restricted to the anchor's patch, solving for translation, scale and
   rotation between the clips; the anchor is tracked through both half seconds.
4. The cut moves to the pair of frames where the anchor's motion matches best (both
   still, or moving the same way at a similar speed), trimming as little as it can.
5. The incoming clip's transform puts its anchor where the outgoing one left it (never
   zoomed further, which would grow the anchor; the renderer fills an uncovered edge
   with a blurred copy of the frame), and the anchor is measured again on the aligned
   frame: what's left is the offset "Check the cut" shows.

Seam: `Aligner` is what the service's route (app/main.py) calls. `LocalAligner` aligns
in this process; `RemoteAligner` sends the same request to the Cloud Run aligner
(app/aligner.py), which runs a `LocalAligner`. ALIGNER_URL picks one. Either way the
answer carries what the Gemini call used, which the service counts (app/usage.py).
"""

import asyncio
import base64
import math
from array import array
from dataclasses import dataclass
from typing import Protocol

import cv2
import httpx
import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, Field, ValidationError
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import RunUsage, UsageLimits

from app.clipping import DEMUXERS, JAIL
from app.errors import AppError
from app.google_auth import id_token
from app.log import log
from app.schemas import (
    AlignRequest,
    AlignResult,
    AnchorPoint,
    Box,
    MatchCutAlignment,
    MatchCutRequest,
    MatchCutTransform,
    TakeVideoType,
    TokenUsage,
)

# The finished video's frame (apps/web lib/stitch.ts), and the half-size one worked in.
OUTPUT_WIDTH = 720
OUTPUT_HEIGHT = 1280
WIDTH = OUTPUT_WIDTH // 2
HEIGHT = OUTPUT_HEIGHT // 2
TO_OUTPUT = OUTPUT_WIDTH / WIDTH
FPS = 15
# How much of each clip around the cut is read, and how many frames either side the cut
# may move to.
WINDOW_SECONDS = 0.5
CANDIDATES = 4
# What trimming one more frame costs against a velocity mismatch, in working pixels a
# frame: a cut moves only for a clearly better match.
TRIM_COST = 0.75
# The spec's tolerance at the cut, in the 720x1280 frame (9.5).
MAX_OFFSET_PX = 8.0
MAX_SCALE_DIFF = 0.03
MAX_ROTATION_DEG = 1.5
# The scales tried around Gemini's estimate before ECC refines.
SEARCH_SCALES = (0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2)
# The anchor's patch is its box grown by this much on each side, for texture around it.
PATCH_MARGIN = 0.15
# Under this correlation, a template match found something else.
MIN_MATCH = 0.4
ECC_CRITERIA = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
FFMPEG_SECONDS = 20.0
LOCATE_TIMEOUT_SECONDS = 20.0
# What the service waits for the Cloud Run aligner: a cold start, two ffmpeg reads and a
# Gemini call. Under apps/api's wait for this service (packages/ai-client, 30 s).
ALIGN_REQUEST_SECONDS = 27.0
JPEG_QUALITY = 80
# ECC's mask over the incoming frame: all of it may hold the anchor.
EVERYWHERE = np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)

type Frame = NDArray[np.uint8]
type Gray = NDArray[np.float32]
type Warp = NDArray[np.float32]

LOCATE_INSTRUCTIONS = """\
You help line up a match cut in a short video: one thing (the anchor) stays on the same
spot of the screen while the background changes between two clips. You get the anchor's
description and two frames: the last frame before the cut and the first after it.

For each frame, say whether the anchor is visible and, if it is, give its tight bounding
box as fractions of the frame (x and y of the top-left corner, then width and height,
from the top-left of the frame). Box only the anchor itself (the watch face, not the whole
arm). If it isn't clearly visible, say so; never guess a box."""


@dataclass(frozen=True)
class AnchorSighting:
    visible: bool
    box: Box | None


@dataclass(frozen=True)
class AnchorSightings:
    before: AnchorSighting
    after: AnchorSighting


# What Gemini answers with: the box as four nullable numbers rather than a nullable
# object, and its bounds checked here rather than in the schema, so the schema Vertex AI
# is sent keeps to what it has always accepted from this service
# (tests/test_output_schemas.py, EditDraft's comment in app/schemas.py).
class AnchorSightingDraft(BaseModel):
    visible: bool
    x: float | None = Field(description="The box's left edge (0 to 1); null when not visible.")
    y: float | None = Field(description="Its top edge (0 to 1).")
    width: float | None = Field(description="Its width (0 to 1).")
    height: float | None = Field(description="Its height (0 to 1).")


class AnchorSightingsDraft(BaseModel):
    before: AnchorSightingDraft = Field(description="In the last frame before the cut.")
    after: AnchorSightingDraft = Field(description="In the first frame after the cut.")


def sighting(draft: AnchorSightingDraft) -> AnchorSighting:
    """Where Gemini saw the anchor. A box that isn't one (a missing edge, or one outside
    the frame) counts as not seen: the cut stays plain rather than lined up wrong."""
    try:
        box = Box.model_validate(draft.model_dump(exclude={"visible"}))
    except ValidationError:
        box = None
    return AnchorSighting(visible=draft.visible and box is not None, box=box)


def sightings(draft: AnchorSightingsDraft) -> AnchorSightings:
    return AnchorSightings(before=sighting(draft.before), after=sighting(draft.after))


class Aligner(Protocol):
    async def align(self, request: AlignRequest) -> AlignResult: ...


def create_locator(model: Model) -> Agent[None, AnchorSightingsDraft]:
    return Agent(
        model,
        output_type=AnchorSightingsDraft,
        instructions=LOCATE_INSTRUCTIONS,
        model_settings=ModelSettings(thinking="low", timeout=LOCATE_TIMEOUT_SECONDS),
        defer_model_check=True,
    )


# ------------------------------------------------------------------------ frames


# What ffmpeg may open for a take: its presigned URL's own protocol and what that runs on,
# nothing a file's contents could name (a local file, another protocol).
PROTOCOLS = {"https": "https,tls,tcp", "http": "http,tcp"}


def frame_command(
    url: str, content_type: TakeVideoType, start_seconds: float, seconds: float
) -> list[str]:
    """ffmpeg reading the take's frames, in the jail (app/jail.py: no secrets, bounded
    resources), as the type it was stored as (never probed: an MP4 that's really a
    playlist isn't followed), over its URL's protocol only. The clipper reads footage the
    same way (app/clipping.py)."""
    scheme = url.split(":", 1)[0].lower()
    if scheme not in PROTOCOLS:
        raise AppError("UPSTREAM_UNAVAILABLE", {"service": "storage"})
    return [
        *JAIL,
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        PROTOCOLS[scheme],
        "-ss",
        f"{start_seconds:.3f}",
        "-f",
        DEMUXERS[content_type],
        "-i",
        url,
        "-t",
        f"{seconds:.3f}",
        "-an",
        "-vf",
        f"fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={WIDTH}:{HEIGHT}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]


async def read_frames(
    url: str, content_type: TakeVideoType, start_seconds: float, seconds: float
) -> list[Frame]:
    """The clip's frames from `start_seconds` for `seconds`, at FPS, each fitted to the
    9:16 working frame (covering it, cropped in the middle) as BGR pixels."""
    # No shell: each argument reaches ffmpeg as its own argv entry, never interpreted.
    process = await asyncio.create_subprocess_exec(
        *frame_command(url, content_type, start_seconds, seconds),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), FFMPEG_SECONDS)
    except (TimeoutError, asyncio.CancelledError) as stopped:
        # Given up on (too slow, or the other side's read failed): killed, never left running.
        process.kill()
        _ = await process.wait()
        if isinstance(stopped, asyncio.CancelledError):
            raise
        raise AppError("UPSTREAM_UNAVAILABLE", {"service": "storage"}) from None
    size = WIDTH * HEIGHT * 3
    if process.returncode != 0 or len(stdout) < size:
        # The reason may name the presigned URL: only its last line, without it, is logged.
        reason = stderr.decode(errors="replace").replace(url, "<url>").strip().splitlines()
        log.warning("couldn't read a take's frames", reason=reason[-1] if reason else None)
        raise AppError("UPSTREAM_UNAVAILABLE", {"service": "storage"})
    count = len(stdout) // size
    pixels = np.frombuffer(stdout[: count * size], dtype=np.uint8)
    return list(pixels.reshape(count, HEIGHT, WIDTH, 3))


def jpeg(frame: Frame) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise ValueError("a frame couldn't be encoded")
    return encoded.tobytes()


def gray(frame: Frame) -> Gray:
    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)


# ------------------------------------------------------------------------ geometry


@dataclass(frozen=True)
class Patch:
    """The anchor's patch in a frame: its pixels and where its top-left corner sits."""

    pixels: Gray
    x: int
    y: int
    width: int
    height: int

    @property
    def centre(self) -> tuple[float, float]:
        return self.x + self.width / 2, self.y + self.height / 2


def patch_of(frame: Gray, box: Box) -> Patch:
    """The anchor's box in `frame`, grown by PATCH_MARGIN, kept inside the frame."""
    margin_x, margin_y = box.width * PATCH_MARGIN, box.height * PATCH_MARGIN
    left = max(0, math.floor((box.x - margin_x) * WIDTH))
    top = max(0, math.floor((box.y - margin_y) * HEIGHT))
    right = min(WIDTH, math.ceil((box.x + box.width + margin_x) * WIDTH))
    bottom = min(HEIGHT, math.ceil((box.y + box.height + margin_y) * HEIGHT))
    right, bottom = max(right, left + 8), max(bottom, top + 8)
    return Patch(frame[top:bottom, left:right].copy(), left, top, right - left, bottom - top)


def moved(patch: Patch, frame: Gray, dx: float, dy: float) -> Patch:
    """The same-sized patch of `frame`, `dx`, `dy` pixels from `patch`."""
    width, height = patch.width, patch.height
    left = round(min(max(0, patch.x + dx), WIDTH - width))
    top = round(min(max(0, patch.y + dy), HEIGHT - height))
    return Patch(frame[top : top + height, left : left + width].copy(), left, top, width, height)


def entries(warp: Warp) -> array[float]:
    """A 2-by-3 warp's six entries, row by row, as plain floats."""
    return array("d", np.ascontiguousarray(warp, dtype=np.float64).tobytes())


def similarity(warp: Warp) -> tuple[float, float]:
    """A warp's scale and rotation (radians, clockwise on screen)."""
    a, b, _, c, d, _ = entries(warp)
    return math.sqrt(abs(a * d - b * c)), math.atan2(c, a)


def apply(warp: Warp, x: float, y: float) -> tuple[float, float]:
    a, b, tx, c, d, ty = entries(warp)
    return a * x + b * y + tx, c * x + d * y + ty


def seed_warp(scale: float, x: float, y: float) -> Warp:
    """The warp from the patch's own pixels into a frame where its top-left corner lands
    at `x`, `y`, `scale` times its size, unturned."""
    return np.array([[scale, 0, x], [0, scale, y]], dtype=np.float32)


def match(patch: Patch, frame: Gray, around: Box | None, scale: float) -> tuple[Warp, float]:
    """Multi-scale template matching of the patch in `frame`, near `around` when given:
    the best warp (translation and scale) and its correlation."""
    best: tuple[Warp, float] = (seed_warp(1, patch.x, patch.y), -1.0)
    width, height = patch.width, patch.height
    for factor in SEARCH_SCALES:
        size = scale * factor
        w, h = max(8, round(width * size)), max(8, round(height * size))
        if w >= WIDTH or h >= HEIGHT:
            continue
        template = np.asarray(
            cv2.resize(patch.pixels, (w, h), interpolation=cv2.INTER_AREA), dtype=np.float32
        )
        left, top, region = 0, 0, frame
        if around is not None:
            # Within a box's size of where Gemini saw it, so a lookalike elsewhere loses.
            cx, cy = (around.x + around.width / 2) * WIDTH, (around.y + around.height / 2) * HEIGHT
            left = max(0, round(cx - w * 1.5))
            top = max(0, round(cy - h * 1.5))
            right, bottom = min(WIDTH, round(cx + w * 1.5)), min(HEIGHT, round(cy + h * 1.5))
            if right - left <= w or bottom - top <= h:
                left, top, right, bottom = 0, 0, WIDTH, HEIGHT
            region = frame[top:bottom, left:right]
        scores = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
        _, score, _, (x, y) = cv2.minMaxLoc(scores)
        if score > best[1]:
            best = (seed_warp(w / width, left + x, top + y), float(score))
    return best


def refine(patch: Patch, frame: Gray, seed: Warp) -> Warp:
    """ECC from the seed: the affine warp that best maps the patch onto `frame`, reduced to
    translation, scale and rotation. The seed when ECC doesn't converge."""
    try:
        _, found = cv2.findTransformECC(
            patch.pixels, frame, seed.copy(), cv2.MOTION_AFFINE, ECC_CRITERIA, EVERYWHERE, 5
        )
    except cv2.error:
        return seed
    warp = np.asarray(found, dtype=np.float32)
    scale, angle = similarity(warp)
    if not 0.5 < scale < 2:
        return seed
    # The patch's centre lands where the affine put it; the shear is dropped.
    width, height = patch.width, patch.height
    cx, cy = apply(warp, width / 2, height / 2)
    cos, sin = scale * math.cos(angle), scale * math.sin(angle)
    return np.array(
        [
            [cos, -sin, cx - (cos * width / 2 - sin * height / 2)],
            [sin, cos, cy - (sin * width / 2 + cos * height / 2)],
        ],
        dtype=np.float32,
    )


def locate(patch: Patch, frame: Gray, around: Box | None, scale: float) -> tuple[Warp, float]:
    """Where the patch is in `frame`: matched, then refined; and the match's correlation."""
    seed, score = match(patch, frame, around, scale)
    return refine(patch, frame, seed), score


def centre_of(patch: Patch, warp: Warp) -> tuple[float, float]:
    return apply(warp, patch.width / 2, patch.height / 2)


# ------------------------------------------------------------------------ the cut


@dataclass(frozen=True)
class Similarity:
    """p' = centre + scale · R(rotation) · (p - centre) + (x, y), in working pixels."""

    scale: float
    rotation: float
    x: float
    y: float

    def matrix(self) -> Warp:
        cx, cy = WIDTH / 2, HEIGHT / 2
        cos, sin = self.scale * math.cos(self.rotation), self.scale * math.sin(self.rotation)
        return np.array(
            [
                [cos, -sin, cx + self.x - (cos * cx - sin * cy)],
                [sin, cos, cy + self.y - (sin * cx + cos * cy)],
            ],
            dtype=np.float32,
        )


def aligning(
    target: tuple[float, float], found: tuple[float, float], scale: float, angle: float
) -> Similarity:
    """The transform of the incoming frame that puts its anchor (at `found`, `scale` times
    the size and turned `angle`) at `target`, at the outgoing size and angle. Never zoomed
    further to cover the frame: that would grow the anchor past the tolerance, so an edge
    the move uncovers is filled by the renderer (a blurred copy of the frame)."""
    k, turn = 1 / scale, -angle
    cos, sin = k * math.cos(turn), k * math.sin(turn)
    cx, cy = WIDTH / 2, HEIGHT / 2
    # found ↦ target: centre + kR(found - centre) + d = target.
    dx = target[0] - cx - (cos * (found[0] - cx) - sin * (found[1] - cy))
    dy = target[1] - cy - (sin * (found[0] - cx) + cos * (found[1] - cy))
    return Similarity(scale=k, rotation=turn, x=dx, y=dy)


def uncovered(transform: Similarity) -> float:
    """How much of the output's side the moved frame leaves uncovered at worst, as a
    fraction: the largest gap at any edge over that edge's length."""
    matrix = transform.matrix()
    corners = [apply(matrix, x, y) for x, y in ((0, 0), (WIDTH, 0), (0, HEIGHT), (WIDTH, HEIGHT))]
    xs, ys = [x for x, _ in corners], [y for _, y in corners]
    gaps = (
        max(0.0, sorted(xs)[1]) / WIDTH,
        max(0.0, WIDTH - sorted(xs)[2]) / WIDTH,
        max(0.0, sorted(ys)[1]) / HEIGHT,
        max(0.0, HEIGHT - sorted(ys)[2]) / HEIGHT,
    )
    return min(1.0, max(gaps))


def pick_cut(
    before: list[tuple[float, float]], after: list[tuple[float, float]]
) -> tuple[int, int]:
    """Which of the outgoing frames to end on and which incoming frame to start on: where
    the anchor's velocity matches best, each frame trimmed costing TRIM_COST. `before`
    and `after` are the anchor's centre in the last and first CANDIDATES frames."""

    def velocity(
        points: list[tuple[float, float]], index: int, forward: bool
    ) -> NDArray[np.float64]:
        if len(points) < 2:
            return np.zeros(2)
        if forward:
            a, b = (index, index + 1) if index + 1 < len(points) else (index - 1, index)
        else:
            a, b = (index - 1, index) if index > 0 else (index, index + 1)
        return np.subtract(points[b], points[a]).astype(np.float64)

    best, choice = math.inf, (len(before) - 1, 0)
    for i in range(len(before)):
        for j in range(len(after)):
            mismatch = float(
                np.linalg.norm(
                    velocity(before, i, forward=False) - velocity(after, j, forward=True)
                )
            )
            cost = mismatch + TRIM_COST * ((len(before) - 1 - i) + j)
            if cost < best - 1e-9:
                best, choice = cost, (i, j)
    return choice


def plain_cut(request: MatchCutRequest) -> MatchCutAlignment:
    """A cut with nothing to line up: where it was asked, untransformed."""
    return MatchCutAlignment(
        status="not-found",
        outgoingEndMs=request.outgoing.atMs,
        incomingStartMs=request.incoming.atMs,
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


def align_frames(
    request: MatchCutRequest,
    outgoing: list[Frame],
    incoming: list[Frame],
    seen: AnchorSightings,
    outgoing_start_ms: int,
) -> MatchCutAlignment:
    """The alignment, from the frames around the cut and where Gemini saw the anchor in
    the two boundary frames (the outgoing's last, the incoming's first)."""
    before_box, after_box = seen.before.box, seen.after.box
    if not (seen.before.visible and seen.after.visible and before_box and after_box):
        return plain_cut(request)
    grays_out = [gray(frame) for frame in outgoing]
    grays_in = [gray(frame) for frame in incoming]
    last = len(grays_out) - 1
    anchor = patch_of(grays_out[last], before_box)
    initial = (after_box.width * after_box.height) / max(1e-6, before_box.width * before_box.height)
    seed_scale = math.sqrt(initial)

    # The anchor through the outgoing clip's last frames (back from the boundary) and the
    # incoming clip's first (on from it).
    first_out = max(0, last - CANDIDATES + 1)
    tracked_out: list[tuple[float, float]] = []
    for index in range(first_out, last + 1):
        warp, _ = locate(anchor, grays_out[index], before_box, 1.0)
        tracked_out.append(centre_of(anchor, warp))
    in_count = min(CANDIDATES, len(grays_in))
    warps_in: list[Warp] = []
    scores_in: list[float] = []
    for index in range(in_count):
        warp, score = locate(anchor, grays_in[index], after_box, seed_scale)
        warps_in.append(warp)
        scores_in.append(score)
    if max(scores_in) < MIN_MATCH:
        # Gemini saw it, but nothing in the incoming clip looks like the outgoing's anchor.
        return plain_cut(request)
    tracked_in = [centre_of(anchor, warp) for warp in warps_in]
    i, j = pick_cut(tracked_out, tracked_in)
    end_index = first_out + i

    # The anchor as it is in the chosen outgoing frame, found in the chosen incoming one.
    ox, oy = tracked_out[i]
    lx, ly = anchor.centre
    chosen = moved(anchor, grays_out[end_index], ox - lx, oy - ly)
    warp, _ = locate(chosen, grays_in[j], after_box, similarity(warps_in[j])[0])
    target, found = chosen.centre, centre_of(chosen, warp)
    scale, angle = similarity(warp)
    transform = aligning(target, found, scale, angle)

    # Measured again on the aligned frame: what's left at the cut.
    aligned = np.asarray(
        cv2.warpAffine(incoming[j], transform.matrix(), (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR),
        dtype=np.uint8,
    )
    check_seed = seed_warp(1, chosen.x, chosen.y)
    check = refine(chosen, gray(aligned), check_seed)
    left_x, left_y = centre_of(chosen, check)
    left_scale, left_angle = similarity(check)
    offset = math.hypot(left_x - target[0], left_y - target[1]) * TO_OUTPUT
    scale_diff = abs(left_scale - 1)
    rotation_diff = abs(math.degrees(left_angle))
    return MatchCutAlignment(
        status="aligned",
        outgoingEndMs=min(
            request.outgoing.atMs, outgoing_start_ms + round((end_index + 1) * 1000 / FPS)
        ),
        incomingStartMs=request.incoming.atMs + round(j * 1000 / FPS),
        transform=MatchCutTransform(
            x=round(transform.x * TO_OUTPUT, 2),
            y=round(transform.y * TO_OUTPUT, 2),
            scale=round(transform.scale, 4),
            rotation=round(math.degrees(transform.rotation), 3),
        ),
        offsetBeforePx=round(math.hypot(found[0] - target[0], found[1] - target[1]) * TO_OUTPUT, 1),
        offsetPx=round(offset, 1),
        scaleDiff=round(scale_diff, 4),
        rotationDiff=round(rotation_diff, 2),
        cropPercent=round(max(1 - 1 / transform.scale, uncovered(transform), 0.0) * 100, 1),
        withinTolerance=within_tolerance(offset, scale_diff, rotation_diff),
        anchor=AnchorPoint(
            x=min(1.0, max(0.0, target[0] / WIDTH)), y=min(1.0, max(0.0, target[1] / HEIGHT))
        ),
        outgoingFrame=base64.b64encode(jpeg(outgoing[end_index])).decode(),
        incomingFrame=base64.b64encode(jpeg(aligned)).decode(),
    )


def within_tolerance(offset_px: float, scale_diff: float, rotation_deg: float) -> bool:
    """The spec's tolerance at the cut (9.5): at most 8 px, 3% and 1.5 degrees."""
    return (
        offset_px <= MAX_OFFSET_PX
        and scale_diff <= MAX_SCALE_DIFF
        and abs(rotation_deg) <= MAX_ROTATION_DEG
    )


# ------------------------------------------------------------------------ aligners


class LocalAligner:
    """Aligns in this process: the service without ALIGNER_URL, and the Cloud Run aligner."""

    def __init__(self, locator: Agent[None, AnchorSightingsDraft]) -> None:
        self._locator = locator

    async def align(self, request: AlignRequest) -> AlignResult:
        out_start = max(0.0, request.outgoing.atMs / 1000 - WINDOW_SECONDS)
        outgoing, incoming = await asyncio.gather(
            read_frames(
                request.outgoing.url,
                request.outgoing.contentType,
                out_start,
                request.outgoing.atMs / 1000 - out_start,
            ),
            read_frames(
                request.incoming.url,
                request.incoming.contentType,
                request.incoming.atMs / 1000,
                WINDOW_SECONDS,
            ),
        )
        usage = RunUsage()
        try:
            seen = await self._locator.run(
                [
                    f"The anchor: {request.anchor}",
                    "The last frame before the cut:",
                    BinaryContent(data=jpeg(outgoing[-1]), media_type="image/jpeg"),
                    "The first frame after the cut:",
                    BinaryContent(data=jpeg(incoming[0]), media_type="image/jpeg"),
                ],
                usage=usage,
                usage_limits=UsageLimits(total_tokens_limit=request.maxTokens),
            )
        except Exception:
            log.exception("locating a match cut's anchor failed")
            raise AppError(
                "UPSTREAM_UNAVAILABLE",
                {
                    "service": "gemini",
                    "inputTokens": usage.input_tokens,
                    "outputTokens": usage.output_tokens,
                },
            ) from None
        # The OpenCV work is CPU-bound: off the event loop, so health checks still answer.
        alignment = await asyncio.to_thread(
            align_frames,
            request,
            outgoing,
            incoming,
            sightings(seen.output),
            round(out_start * 1000),
        )
        return AlignResult(
            alignment=alignment,
            usage=TokenUsage(inputTokens=usage.input_tokens, outputTokens=usage.output_tokens),
        )


class RemoteAligner:
    """Sends the request to the Cloud Run aligner at `url` (app/aligner.py), as this
    machine's service account: an ID token for `url` from the metadata server, which
    Cloud Run's IAM and the aligner itself both check."""

    def __init__(self, url: str, http: httpx.AsyncClient) -> None:
        self._url = url
        self._http = http

    async def align(self, request: AlignRequest) -> AlignResult:
        # Once sent, what the aligner used is unknown on a failure: the whole reservation.
        unknown = {"inputTokens": request.maxTokens, "outputTokens": 0}
        try:
            token = await id_token(self._url)
            response = await self._http.post(
                f"{self._url}/v1/align",
                content=request.model_dump_json(),
                headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
                timeout=ALIGN_REQUEST_SECONDS,
            )
        except httpx.HTTPError as error:
            log.warning("couldn't reach the aligner", error=type(error).__name__)
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "aligner", **unknown}) from None
        if not response.is_success:
            log.warning("the aligner refused", status=response.status_code)
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "aligner", **unknown})
        try:
            return AlignResult.model_validate_json(response.content)
        except ValidationError as error:
            log.warning("the aligner's answer isn't an AlignResult", errors=error.error_count())
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "aligner", **unknown}) from None
