"""Veo clips for the gaps of a member's video (spec 8.7): B-roll for a moment the original
cut away to, or a shot the member skipped. A clip is a row of ai.director_asset like a
drawn image (origin `created`), told apart by its model, which the picker sets to
VEO_MODEL when the member asks for a clip; the assets job makes it here instead of
drawing it, and keeps it beside the slot's images as an MP4.

Veo answers through a long-running operation: it is polled until done, within
CLIP_TIMEOUT_SECONDS. The clip is silent B-roll (the member's own sound plays under it)
and anyone in it is a generic, anonymous adult; using one sets YouTube's "altered or
synthetic content" flag when the video is published (apps/api publish).
"""

import asyncio
from dataclasses import dataclass

from google.genai.types import GenerateVideosConfig, GenerateVideosOperation
from pydantic_ai.models.google import GoogleModel

# Veo makes 4 to 8 seconds; B-roll cuts are short, and a gap longer than a clip loops it.
CLIP_SECONDS = 8
# A Veo clip takes a minute or two; past this it has failed.
CLIP_TIMEOUT_SECONDS = 6 * 60
_POLL_SECONDS = 10
_STYLE = (
    "Vertical 9:16 B-roll for a short video. Photo-real, natural light, steady camera with a "
    "gentle move. Anyone in it is a generic, anonymous adult, not a likeness of any real "
    "person. No text, no logos, no watermarks."
)


_NEGATIVE = "text, captions, subtitles, logos, watermarks, brand names"


class NoClip(ValueError):
    """An operation that ended with no clip (held back by a safety filter, or failed)."""


@dataclass(frozen=True)
class Clip:
    data: bytes
    media_type: str


def veo_address(model_name: str, project: str | None, location: str) -> str:
    """What Vertex is sent for Veo: its full resource name in `location` (Veo isn't served
    from the "global" location the Gemini models are, and with an API key only the full
    name carries the project, which a long-running call needs). Without a project (the
    Gemini API), the bare name."""
    if project is None:
        return model_name
    return f"projects/{project}/locations/{location}/publishers/google/models/{model_name}"


def clip_prompt(prompt: str) -> str:
    return f"{prompt}\n{_STYLE}"


class Filmmaker:
    """Veo (VEO_MODEL), making one clip at a time through the Gemini client underneath
    the model Director builds everything else with."""

    def __init__(self, model: GoogleModel, model_name: str, address: str) -> None:
        # `model_name` is the short name the usage ledger and the rows record; `address`
        # is what Vertex is sent (`veo_address`).
        self._model = model
        self.model_name = model_name
        self._address = address

    async def film(self, prompt: str) -> Clip:
        client = self._model.client.aio
        operation: GenerateVideosOperation = await client.models.generate_videos(
            model=self._address,
            prompt=clip_prompt(prompt),
            config=GenerateVideosConfig(
                aspect_ratio="9:16",
                duration_seconds=CLIP_SECONDS,
                resolution="720p",
                number_of_videos=1,
                person_generation="allow_adult",
                generate_audio=False,
                negative_prompt=_NEGATIVE,
            ),
        )
        waited = 0
        while not operation.done:
            if waited >= CLIP_TIMEOUT_SECONDS:
                raise TimeoutError("Veo took too long")
            await asyncio.sleep(_POLL_SECONDS)
            waited += _POLL_SECONDS
            operation = await client.operations.get(operation)
        response = operation.response
        videos = response.generated_videos if response else None
        video = videos[0].video if videos else None
        if video is None or not video.video_bytes:
            raise NoClip(f"no clip in the answer: {operation.error}")
        return Clip(video.video_bytes, video.mime_type or "video/mp4")
