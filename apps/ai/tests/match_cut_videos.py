"""Synthetic match-cut footage for the aligner's tests: two clips in different "rooms"
(unrelated noise), each with the same textured "watch" on it, placed, sized and turned as
a test says, and moving at a set speed. Written as real MP4 files with OpenCV, so the
aligner reads them through ffmpeg exactly as it reads a member's takes."""

import asyncio
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray

# A portrait take, as a phone records one (not the output's size: the aligner fits it).
WIDTH, HEIGHT = 540, 960
FPS = 30
WATCH = 90


def _watch() -> NDArray[np.uint8]:
    """A watch face: rings, hands and ticks, in colour, with enough texture to track."""
    face = np.full((WATCH, WATCH, 3), 30, np.uint8)
    centre = WATCH // 2
    cv2.circle(face, (centre, centre), centre - 2, (40, 180, 230), -1)
    cv2.circle(face, (centre, centre), centre - 10, (250, 250, 250), -1)
    for tick in range(12):
        angle = tick * math.pi / 6
        x1, y1 = centre + 30 * math.cos(angle), centre + 30 * math.sin(angle)
        x2, y2 = centre + 38 * math.cos(angle), centre + 38 * math.sin(angle)
        cv2.line(face, (int(x1), int(y1)), (int(x2), int(y2)), (20, 20, 20), 3)
    cv2.line(face, (centre, centre), (centre + 22, centre - 12), (10, 10, 120), 4)
    cv2.line(face, (centre, centre), (centre - 8, centre - 30), (10, 10, 10), 3)
    cv2.putText(
        face, "MM", (centre - 14, centre + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 90, 0), 2
    )
    return face


@dataclass(frozen=True)
class Placement:
    """Where the watch's centre is (take pixels), how big and how turned, and how it
    moves each frame."""

    x: float
    y: float
    scale: float = 1.0
    rotation: float = 0.0
    vx: float = 0.0
    vy: float = 0.0


def write_clip(path: Path, room: int, placement: Placement, seconds: float = 1.5) -> None:
    """The clip as an MP4 with its index first, as a browser's or phone's upload is, so it
    plays (and seeks) as it streams from storage."""
    raw = path.with_suffix(".raw.mp4")
    _draw(raw, room, placement, seconds)
    asyncio.run(_faststart(raw, path))
    raw.unlink()


async def _faststart(source: Path, path: Path) -> None:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(path),
    )
    if await process.wait() != 0:
        raise RuntimeError("ffmpeg couldn't remux the clip")


def _draw(path: Path, room: int, placement: Placement, seconds: float) -> None:
    rng = np.random.default_rng(room)
    background = cv2.GaussianBlur(
        rng.integers(0, 255, (HEIGHT, WIDTH, 3), dtype=np.uint8), (0, 0), 3
    )
    watch = _watch()
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter.fourcc(*"mp4v"), FPS, (WIDTH, HEIGHT))
    for index in range(round(seconds * FPS)):
        frame = background.copy()
        x, y = placement.x + placement.vx * index, placement.y + placement.vy * index
        matrix = cv2.getRotationMatrix2D(
            (WATCH / 2, WATCH / 2), -placement.rotation, placement.scale
        )
        matrix[0, 2] += x - WATCH / 2
        matrix[1, 2] += y - WATCH / 2
        mask = cv2.warpAffine(np.full((WATCH, WATCH), 255, np.uint8), matrix, (WIDTH, HEIGHT))
        drawn = cv2.warpAffine(watch, matrix, (WIDTH, HEIGHT))
        frame[mask > 127] = drawn[mask > 127]
        writer.write(frame)
    writer.release()


def output_box(placement: Placement, at_frame: int) -> dict[str, float]:
    """The watch's box as Gemini would give it, in fractions of the frame: the take is
    already 9:16, so the fractions are the same in the output."""
    size = WATCH * placement.scale
    x = placement.x + placement.vx * at_frame
    y = placement.y + placement.vy * at_frame
    return {
        "x": (x - size / 2) / WIDTH,
        "y": (y - size / 2) / HEIGHT,
        "width": size / WIDTH,
        "height": size / HEIGHT,
    }
