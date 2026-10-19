"""Veo making a gap's clip (app/clips.py), against a local Vertex AI that speaks its
long-running prediction protocol (tests/fakes.py): started, polled until done, and the
ways it ends without a clip."""

import asyncio
import os
from collections.abc import Callable, Iterator
from unittest.mock import patch

import pytest
from pydantic import BaseModel

from app import clips
from app.clips import CLIP_SECONDS, Filmmaker, NoClip, veo_address
from app.director import create_google_model
from app.settings import GeminiSettings
from tests.fakes import (
    VEO_FILTERED,
    VEO_RUNNING,
    VERTEX_PROJECT,
    Fake,
    Reply,
    serve,
    veo_done,
    veo_failed,
    veo_polls,
    veo_started,
    vertex_path,
)

pytestmark = pytest.mark.integration

MODEL = "veo-test"
START = vertex_path("us-central1", MODEL, "predictLongRunning")
POLL = vertex_path("us-central1", MODEL, "fetchPredictOperation")

type Vertex = tuple[Fake, dict[str, Callable[[bytes], Reply]]]


class _Instance(BaseModel):
    prompt: str


class _Started(BaseModel):
    """What the start of a prediction carries, of what these tests check."""

    instances: list[_Instance]
    parameters: dict[str, object]


@pytest.fixture
def vertex(monkeypatch: pytest.MonkeyPatch) -> Iterator[Vertex]:
    # Polled at once rather than every ten seconds.
    monkeypatch.setattr(clips, "_POLL_SECONDS", 0)
    handlers: dict[str, Callable[[bytes], Reply]] = {START: veo_started(MODEL)}
    with serve(handlers) as fake:
        yield fake, handlers


def filmmaker(fake: Fake) -> Filmmaker:
    """Veo on Vertex with an express key, as the service builds it (create_asset_maker)."""
    env = {
        "GOOGLE_VERTEX": "true",
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": fake.url,
        "GOOGLE_CLOUD_PROJECT": VERTEX_PROJECT,
    }
    with patch.dict(os.environ, {}, clear=True):
        settings = GeminiSettings.model_validate(env)
    model = create_google_model(settings, MODEL)
    return Filmmaker(model, MODEL, veo_address(MODEL, VERTEX_PROJECT, "us-central1"))


def test_veo_is_polled_until_the_clip_is_ready(vertex: Vertex) -> None:
    fake, handlers = vertex
    handlers[POLL] = veo_polls(MODEL, VEO_RUNNING, veo_done(b"mp4"))

    clip = asyncio.run(filmmaker(fake).film("A kitchen at dawn"))

    assert (clip.data, clip.media_type) == (b"mp4", "video/mp4")
    assert [path for path, _ in fake.received] == [START, POLL, POLL]
    [started] = [
        _Started.model_validate_json(body) for path, body in fake.received if path == START
    ]
    [instance] = started.instances
    assert instance.prompt.startswith("A kitchen at dawn\nVertical 9:16")
    assert started.parameters == {
        "aspectRatio": "9:16",
        "durationSeconds": CLIP_SECONDS,
        "resolution": "720p",
        "sampleCount": 1,
        "personGeneration": "allow_adult",
        "generateAudio": False,
        "negativePrompt": "text, captions, subtitles, logos, watermarks, brand names",
    }


@pytest.mark.parametrize(("outcome", "match"), [(veo_failed("quota"), "quota"), (VEO_FILTERED, "")])
def test_an_operation_that_ends_without_a_clip_is_no_clip(
    vertex: Vertex, outcome: Reply, match: str
) -> None:
    fake, handlers = vertex
    handlers[POLL] = veo_polls(MODEL, outcome)

    with pytest.raises(NoClip, match=match):
        _ = asyncio.run(filmmaker(fake).film("A kitchen at dawn"))


def test_veo_taking_too_long_is_given_up_on(
    vertex: Vertex, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake, handlers = vertex
    handlers[POLL] = veo_polls(MODEL, VEO_RUNNING)
    monkeypatch.setattr(clips, "CLIP_TIMEOUT_SECONDS", 0)

    with pytest.raises(TimeoutError):
        _ = asyncio.run(filmmaker(fake).film("A kitchen at dawn"))
    assert [path for path, _ in fake.received] == [START]
