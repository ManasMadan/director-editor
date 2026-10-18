"""Tests for scripts/seed_media.py. The pure parts (prompts, what's missing, the cost, the
run that writes each key) take the media models and the upload injected; the real
models' client is exercised against a local stand-in for Vertex AI's media endpoints
(tests/fakes.py), never against Vertex itself, so those are integration tests (a local
HTTP server)."""

import asyncio
import gc
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import pytest
from google.auth.credentials import AnonymousCredentials, Credentials
from google.genai import errors as genai_errors
from google.oauth2.credentials import Credentials as UserCredentials
from pydantic import BaseModel

from app.schemas import Shot, ShotPlan
from app.settings import Settings
from scripts import seed_media
from scripts.build_seeds import (
    APP_ROOT,
    TEMPLATES_PATH,
    SeedTemplate,
    load_templates,
    write_templates,
)
from scripts.seed_media import (
    MUSIC_MODEL,
    PREVIEW_LOCATION,
    PREVIEW_MODEL,
    STORYBOARD_MODEL,
    Job,
    Media,
    VertexMediaModels,
    access_token,
    connect_vertex,
    estimated_usd,
    gcs_upload,
    generate,
    main,
    media_jobs,
    music_prompt,
    preview_prompt,
    preview_seconds,
    storyboard_prompt,
)
from tests.fakes import (
    VEO_FILTERED,
    VEO_RUNNING,
    VERTEX_PROJECT,
    Fake,
    Reply,
    gemini_error,
    serve,
    veo_done,
    veo_failed,
    veo_polls,
    veo_started,
    vertex_inline,
    vertex_path,
    vertex_text_only,
)
from tests.tokens import SECRET

VIDEO = "22k0fZarxh8"
OTHER = "152Jy2c3XSM"

PERSON_SHOT: dict[str, object] = {
    "kind": "video",
    "title": "Intro in the Market",
    "purpose": "hook: introduce the observation, curious and friendly",
    "sourceStartSeconds": 0,
    "sourceEndSeconds": 2,
    "durationSeconds": 2,
    "camera": "back",
    "scene": "Stand in a busy outdoor market street.",
    "sceneLandmark": "street",
    "framing": {
        "shotSize": "medium",
        "subject": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
        "note": "Center yourself from the waist up.",
    },
    "phoneAngle": {"pitch": 0, "roll": 0, "tolerance": 10, "height": "eye"},
    "pose": {
        "description": "Standing upright facing the camera, gesturing.",
        "keypoints": [{"name": "nose", "x": 0.5, "y": 0.3}],
    },
    "steps": [{"atSeconds": 0, "instruction": "Say hello to Brandname.", "cameraMove": "static"}],
    "script": [{"startSeconds": 0, "endSeconds": 2, "text": "Hi from Brandname."}],
}
OBJECT_SHOT: dict[str, object] = {
    **PERSON_SHOT,
    "title": "The Reveal",
    "purpose": "payoff: the finished cake, mouthwatering",
    "sourceStartSeconds": 2,
    "sourceEndSeconds": 10,
    "durationSeconds": 8,
    "scene": "At a kitchen counter.",
    "framing": {
        "shotSize": "close-up",
        "subject": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
        "note": "The cake fills the frame.",
    },
    "phoneAngle": {"pitch": -60, "roll": 0, "tolerance": 10, "height": "overhead"},
    "pose": {"description": "No person in frame; a hand with a fork.", "keypoints": []},
    "steps": [
        {"atSeconds": 0, "instruction": "Hold still.", "cameraMove": "static"},
        {"atSeconds": 3, "instruction": "Lower the phone.", "cameraMove": "down"},
    ],
    "script": [],
}
PLAN: dict[str, object] = {
    "title": "A Brandname Plan",
    "format": "Travel Vlog",
    "summary": "Brandname's summary.",
    "audio": "music",
    "durationSeconds": 10,
    "shots": [PERSON_SHOT, OBJECT_SHOT],
}


def template(video_id: str = VIDEO, **plan: object) -> SeedTemplate:
    return SeedTemplate(
        videoId=video_id,
        plan=ShotPlan.model_validate({**PLAN, **plan}),
        model="gemini-4-argon",
        audioKey=f"seed-audio/{video_id}.m4a",
    )


def person() -> Shot:
    return Shot.model_validate(PERSON_SHOT)


def thing() -> Shot:
    return Shot.model_validate(OBJECT_SHOT)


class FakeModels:
    """The media models, answering at once with recognizable bytes; a prompt containing
    `refuse` fails, as a model's refusal or outage would."""

    def __init__(self, refuse: str = "", music_type: str = "audio/mpeg") -> None:
        self.refuse = refuse
        self.music_type = music_type
        self.asked: list[tuple[str, str]] = []

    def _check(self, kind: str, prompt: str) -> None:
        self.asked.append((kind, prompt))
        if self.refuse and self.refuse in prompt:
            raise RuntimeError(f"the {kind} model refused")

    async def storyboard(self, prompt: str) -> Media:
        self._check("storyboard", prompt)
        return b"png", "image/png"

    async def preview(self, prompt: str, seconds: int) -> Media:
        self._check("preview", prompt)
        return f"mp4 {seconds}s".encode(), "video/mp4"

    async def music(self, prompt: str) -> Media:
        self._check("music", prompt)
        return b"track", self.music_type


class Uploads:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def __call__(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)


# ------------------------------------------------------------------------------ prompts


def test_the_storyboard_prompt_draws_the_shot_from_its_own_directions() -> None:
    prompt = storyboard_prompt(person())

    for field in (
        "Stand in a busy outdoor market street.",
        "medium shot",
        "Center yourself from the waist up.",
        "Standing upright facing the camera, gesturing.",
        "hook: introduce the observation, curious and friendly",
        "9:16",
    ):
        assert field in prompt
    # A person is anyone, never the creator; nothing written into the picture.
    assert "generic" in prompt
    assert "not a likeness of any real" in prompt
    assert "No text" in prompt
    # Only the shot's own directions: no titles, steps or lines, which can name a brand.
    assert "Brandname" not in prompt
    assert "Intro in the Market" not in prompt


def test_the_preview_prompt_describes_the_clip_and_how_the_camera_moves() -> None:
    still = preview_prompt(person(), 4)
    moving = preview_prompt(thing(), 6)

    assert "4-second" in still
    assert "eye height" in still
    assert "The camera holds still." in still
    assert "6-second" in moving
    assert "The camera moves down." in moving
    assert "overhead height" in moving
    for prompt in (still, moving):
        assert "generic" in prompt
        assert "Brandname" not in prompt
    assert "At a kitchen counter." in moving
    assert "The cake fills the frame." in moving


def test_a_preview_is_four_seconds_for_a_short_shot_and_six_for_a_longer_one() -> None:
    assert preview_seconds(person()) == 4
    assert preview_seconds(Shot.model_validate({**PERSON_SHOT, "durationSeconds": 5})) == 4
    assert preview_seconds(Shot.model_validate({**PERSON_SHOT, "durationSeconds": 5.1})) == 6
    assert preview_seconds(thing()) == 6


def test_the_music_prompt_follows_the_plan_s_moods_and_pace() -> None:
    prompt = music_prompt(ShotPlan.model_validate(PLAN))

    assert "Instrumental only" in prompt
    assert "Travel Vlog" in prompt
    assert "10-second" in prompt
    assert prompt.index("curious and friendly") < prompt.index("mouthwatering")
    assert "2 shots" in prompt
    assert "Brandname" not in prompt


def test_the_music_prompt_reads_the_pace_from_how_often_it_cuts() -> None:
    fast = ShotPlan.model_validate({**PLAN, "durationSeconds": 4})
    slow = ShotPlan.model_validate({**PLAN, "durationSeconds": 40, "shots": [OBJECT_SHOT]})

    assert "fast" in music_prompt(fast)
    assert "slow" in music_prompt(slow)
    assert "steady" in music_prompt(ShotPlan.model_validate(PLAN))


# ------------------------------------------------------------------------- what's missing


def test_every_missing_medium_is_a_job_in_the_seed_file_s_order() -> None:
    jobs = media_jobs([template(), template(OTHER)])

    assert [(job.kind, job.seed, job.shot) for job in jobs] == [
        ("storyboard", 0, 0),
        ("preview", 0, 0),
        ("storyboard", 0, 1),
        ("preview", 0, 1),
        ("music", 0, None),
        ("storyboard", 1, 0),
        ("preview", 1, 0),
        ("storyboard", 1, 1),
        ("preview", 1, 1),
        ("music", 1, None),
    ]
    assert [job.seconds for job in jobs if job.kind == "preview"] == [4, 6, 4, 6]
    assert jobs[0].prompt == storyboard_prompt(person())
    assert jobs[3].prompt == preview_prompt(thing(), 6)


def test_what_already_has_a_key_is_skipped() -> None:
    done = template(
        musicKey=f"seed-media/{VIDEO}/music.mp3",
        shots=[
            {**PERSON_SHOT, "storyboardKey": "a.png", "previewKey": "a.mp4"},
            {**OBJECT_SHOT, "storyboardKey": "b.png"},
        ],
    )

    assert [(job.kind, job.shot) for job in media_jobs([done])] == [("preview", 1)]


def test_previews_stop_at_the_cap_counting_the_ones_already_made() -> None:
    one_made = template(shots=[{**PERSON_SHOT, "previewKey": "a.mp4"}, OBJECT_SHOT])

    jobs = media_jobs([one_made, template(OTHER)], max_previews=3)

    assert [(job.seed, job.shot) for job in jobs if job.kind == "preview"] == [(0, 1), (1, 0)]
    # The cap holds back clips only: every storyboard is still made.
    assert len([job for job in jobs if job.kind == "storyboard"]) == 4


def test_the_estimate_prices_each_image_second_of_video_and_track() -> None:
    jobs = [
        Job("storyboard", 0, 0, "p"),
        Job("preview", 0, 0, "p", seconds=4),
        Job("preview", 0, 1, "p", seconds=6),
        Job("music", 0, None, "p"),
    ]

    assert estimated_usd(jobs) == pytest.approx(
        seed_media.STORYBOARD_USD + 10 * seed_media.PREVIEW_USD_PER_SECOND + seed_media.MUSIC_USD
    )


# ------------------------------------------------------------------------------ the run


async def test_each_medium_is_uploaded_and_its_key_written_as_it_lands(tmp_path: Path) -> None:
    path = tmp_path / "templates.json"
    templates = [template()]
    uploads = Uploads()
    saved: list[int] = []

    def save(written: list[SeedTemplate]) -> None:
        write_templates(written, path)
        saved.append(sum(1 for line in path.read_text().splitlines() if "Key" in line))

    failures = await generate(templates, media_jobs(templates), FakeModels(), uploads, save)

    assert failures == 0
    [written] = load_templates(path)
    assert written.plan.musicKey == f"seed-media/{VIDEO}/music.mp3"
    assert [(shot.storyboardKey, shot.previewKey) for shot in written.plan.shots] == [
        (f"seed-media/{VIDEO}/shot-0.png", f"seed-media/{VIDEO}/shot-0.mp4"),
        (f"seed-media/{VIDEO}/shot-1.png", f"seed-media/{VIDEO}/shot-1.mp4"),
    ]
    assert uploads.objects == {
        f"seed-media/{VIDEO}/shot-0.png": (b"png", "image/png"),
        f"seed-media/{VIDEO}/shot-0.mp4": (b"mp4 4s", "video/mp4"),
        f"seed-media/{VIDEO}/shot-1.png": (b"png", "image/png"),
        f"seed-media/{VIDEO}/shot-1.mp4": (b"mp4 6s", "video/mp4"),
        f"seed-media/{VIDEO}/music.mp3": (b"track", "audio/mpeg"),
    }
    # Saved after every one, so a run that stops halfway keeps what it paid for.
    assert len(saved) == 5
    # Everything else about the seed is as it was.
    assert written.model_dump(exclude={"plan"}) == templates[0].model_dump(exclude={"plan"})
    # A second run finds nothing left to make.
    assert media_jobs([written]) == []


async def test_a_failed_medium_leaves_its_key_unset_and_the_rest_still_land(
    tmp_path: Path,
) -> None:
    path = tmp_path / "templates.json"
    templates = [template()]
    models = FakeModels(refuse="At a kitchen counter.")

    failures = await generate(
        templates, media_jobs(templates), models, Uploads(), lambda t: write_templates(t, path)
    )

    assert failures == 2
    [written] = load_templates(path)
    assert written.plan.shots[0].storyboardKey is not None
    assert written.plan.shots[0].previewKey is not None
    assert written.plan.shots[1].storyboardKey is None
    assert written.plan.shots[1].previewKey is None
    assert written.plan.musicKey is not None
    assert [(job.kind, job.shot) for job in media_jobs([written])] == [
        ("storyboard", 1),
        ("preview", 1),
    ]


async def test_the_music_key_takes_the_format_lyria_answered_with() -> None:
    templates = [template()]
    jobs = [job for job in media_jobs(templates) if job.kind == "music"]

    await generate(templates, jobs, FakeModels(music_type="audio/wav"), Uploads(), lambda _: None)

    assert templates[0].plan.musicKey == f"seed-media/{VIDEO}/music.wav"


async def test_a_format_it_can_t_name_fails_that_medium() -> None:
    templates = [template()]
    jobs = [job for job in media_jobs(templates) if job.kind == "music"]
    uploads = Uploads()

    failures = await generate(
        templates, jobs, FakeModels(music_type="audio/ogg"), uploads, lambda _: None
    )

    assert failures == 1
    assert templates[0].plan.musicKey is None
    assert uploads.objects == {}


# ------------------------------------------------------------------------- the command


def _env() -> dict[str, str]:
    return {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": SECRET,
        "GOOGLE_CLOUD_PROJECT": VERTEX_PROJECT,
        "LOG_LEVEL": "warning",
    }


@pytest.fixture
def env() -> Iterator[None]:
    """Exactly these settings: the process environment (a loaded .env) must not leak in."""
    with patch.dict(os.environ, _env(), clear=True):
        seed_media.get_settings.cache_clear()
        yield
    seed_media.get_settings.cache_clear()


@pytest.mark.usefixtures("env")
async def test_a_dry_run_says_what_it_would_make_and_makes_nothing(tmp_path: Path) -> None:
    path = tmp_path / "templates.json"
    write_templates([template()], path)
    before = path.read_bytes()

    async def connect(_settings: Settings, _bucket: str) -> tuple[FakeModels, Uploads]:
        raise AssertionError("a dry run connects to nothing")

    assert await main(["--bucket", "b", "--dry-run"], path, connect) == 0
    assert path.read_bytes() == before


@pytest.mark.usefixtures("env")
async def test_the_command_makes_what_s_missing_into_the_bucket_it_names(tmp_path: Path) -> None:
    path = tmp_path / "templates.json"
    write_templates([template()], path)
    uploads = Uploads()
    buckets: list[str] = []

    async def connect(settings: Settings, bucket: str) -> tuple[FakeModels, Uploads]:
        assert settings.google_cloud_project == VERTEX_PROJECT
        buckets.append(bucket)
        return FakeModels(), uploads

    assert await main(["--bucket", "seed-bucket", "--concurrency", "2"], path, connect) == 0
    assert buckets == ["seed-bucket"]
    assert len(uploads.objects) == 5
    assert media_jobs(load_templates(path)) == []
    # Nothing left: a second run connects to nothing.
    assert await main(["--bucket", "seed-bucket"], path, connect) == 0
    assert buckets == ["seed-bucket"]


@pytest.mark.usefixtures("env")
async def test_the_command_fails_when_a_medium_did_so_it_s_run_again(tmp_path: Path) -> None:
    path = tmp_path / "templates.json"
    write_templates([template()], path)

    async def connect(_settings: Settings, _bucket: str) -> tuple[FakeModels, Uploads]:
        return FakeModels(refuse="Instrumental"), Uploads()

    assert await main(["--bucket", "b"], path, connect) == 1
    assert load_templates(path)[0].plan.musicKey is None


def test_the_command_needs_a_bucket() -> None:
    with pytest.raises(SystemExit):
        seed_media.parse_args([])


# --------------------------------------------------------------------------- credentials


# Stands in for `gcloud auth print-access-token`.
PRINTS_A_TOKEN = [sys.executable, "-c", "print('ya29.test-token')"]


async def test_access_token_is_what_the_command_prints() -> None:
    assert await access_token(PRINTS_A_TOKEN) == "ya29.test-token"


async def test_access_token_fails_when_the_command_does() -> None:
    with pytest.raises(RuntimeError, match="gcloud"):
        await access_token([sys.executable, "-c", "import sys; sys.exit(1)"])


type Uploaded = list[tuple[str, str, bytes, str]]


class _Blob:
    def __init__(self, uploaded: Uploaded, bucket: str, key: str) -> None:
        self.uploaded = uploaded
        self.bucket = bucket
        self.key = key

    def upload_from_string(self, data: bytes, content_type: str) -> None:
        self.uploaded.append((self.bucket, self.key, data, content_type))


class _Bucket:
    def __init__(self, uploaded: Uploaded, name: str) -> None:
        self.uploaded = uploaded
        self.name = name

    def blob(self, key: str) -> _Blob:
        return _Blob(self.uploaded, self.name, key)


def storage_client(uploaded: Uploaded, clients: list[tuple[str, Credentials]]) -> type:
    """Cloud Storage's client, as far as gcs_upload uses it: what it uploads, recorded."""

    class Client:
        def __init__(self, project: str, credentials: Credentials) -> None:
            clients.append((project, credentials))

        def bucket(self, name: str) -> _Bucket:
            return _Bucket(uploaded, name)

    return Client


async def test_gcs_upload_writes_the_object_with_its_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploaded: Uploaded = []
    clients: list[tuple[str, Credentials]] = []
    monkeypatch.setattr(seed_media.storage, "Client", storage_client(uploaded, clients))
    credentials = AnonymousCredentials()
    upload = gcs_upload("seed-bucket", credentials, VERTEX_PROJECT)

    await upload("seed-media/x/shot-0.png", b"png", "image/png")

    assert clients == [(VERTEX_PROJECT, credentials)]
    assert uploaded == [("seed-bucket", "seed-media/x/shot-0.png", b"png", "image/png")]


# ------------------------------------------------------------- Vertex AI's media models


type Vertex = tuple[Fake, dict[str, Callable[[bytes], Reply]]]


@pytest.fixture
def vertex(monkeypatch: pytest.MonkeyPatch) -> Iterator[Vertex]:
    """Vertex AI's media endpoints, each model's handler set by the test, with the Cloud
    Storage client the script would build stood in for."""
    monkeypatch.setattr(seed_media.storage, "Client", storage_client([], []))
    handlers: dict[str, Callable[[bytes], Reply]] = {}
    with serve(handlers) as fake:
        yield fake, handlers


def settings_for(**env: str) -> Settings:
    """Settings from exactly these values: a loaded .env must not leak in."""
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate({**_env(), **env})


async def models_at(fake: Fake) -> VertexMediaModels:
    models, _ = await connect_vertex(
        settings_for(GOOGLE_BASE_URL=fake.url),
        "seed-bucket",
        poll_seconds=0,
        retry_seconds=0,
        token_command=PRINTS_A_TOKEN,
    )
    assert isinstance(models, VertexMediaModels)
    return models


class _Request(BaseModel):
    generationConfig: dict[str, object] | None = None
    parameters: dict[str, object] | None = None


def _request(fake: Fake, path: str) -> tuple[str, _Request]:
    [body] = [body.decode() for received, body in fake.received if received == path]
    return body, _Request.model_validate_json(body)


@pytest.mark.integration
async def test_nano_banana_draws_a_portrait_card(vertex: Vertex) -> None:
    fake, handlers = vertex
    path = vertex_path("global", STORYBOARD_MODEL, "generateContent")
    handlers[path] = vertex_inline("image/png", b"\x89PNG")

    assert await (await models_at(fake)).storyboard("a card") == (b"\x89PNG", "image/png")
    body, request = _request(fake, path)
    assert request.generationConfig == {
        "responseModalities": ["IMAGE"],
        "imageConfig": {"aspectRatio": "9:16", "imageSize": "1K"},
    }
    assert "a card" in body


@pytest.mark.integration
async def test_the_models_keep_their_connections_open_for_the_whole_run(vertex: Vertex) -> None:
    """google-genai closes a client's connections once nothing holds the client, so the
    models must hold theirs: a storyboard asked for well after connecting still lands."""
    fake, handlers = vertex
    handlers[vertex_path("global", STORYBOARD_MODEL, "generateContent")] = vertex_inline(
        "image/png", b"\x89PNG"
    )
    models = await models_at(fake)
    gc.collect()
    await asyncio.sleep(0)

    assert await models.storyboard("a card") == (b"\x89PNG", "image/png")
    assert await models.storyboard("another card") == (b"\x89PNG", "image/png")


def _in_turn(*replies: Callable[[bytes], Reply]) -> Callable[[bytes], Reply]:
    """Each handler once, in turn, then the last one for good."""
    remaining = list(replies)

    def reply(body: bytes) -> Reply:
        return (remaining.pop(0) if len(remaining) > 1 else remaining[0])(body)

    return reply


QUOTA_SPENT = gemini_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded for veo")


@pytest.mark.integration
async def test_a_spent_quota_is_waited_out_and_tried_again(vertex: Vertex) -> None:
    """Vertex answers 429 once a model's per-minute quota is spent (Veo's is a few
    requests a minute): each call waits and tries again rather than failing its medium."""
    fake, handlers = vertex
    start = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "predictLongRunning")
    poll = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "fetchPredictOperation")
    image = vertex_path("global", STORYBOARD_MODEL, "generateContent")
    handlers[start] = _in_turn(QUOTA_SPENT, QUOTA_SPENT, veo_started(PREVIEW_MODEL))
    handlers[poll] = _in_turn(QUOTA_SPENT, veo_polls(PREVIEW_MODEL, veo_done(b"mp4")))
    handlers[image] = _in_turn(QUOTA_SPENT, vertex_inline("image/png", b"\x89PNG"))
    models = await models_at(fake)

    assert await models.preview("a clip", 4) == (b"mp4", "video/mp4")
    assert await models.storyboard("a card") == (b"\x89PNG", "image/png")
    paths = [path for path, _ in fake.received]
    assert (paths.count(start), paths.count(poll), paths.count(image)) == (3, 2, 2)


@pytest.mark.integration
async def test_a_quota_still_spent_after_every_retry_fails_the_medium(vertex: Vertex) -> None:
    fake, handlers = vertex
    path = vertex_path("global", MUSIC_MODEL, "generateContent")
    handlers[path] = QUOTA_SPENT

    with pytest.raises(genai_errors.ClientError, match="RESOURCE_EXHAUSTED"):
        await (await models_at(fake)).music("a track")
    assert [received for received, _ in fake.received].count(path) == seed_media.QUOTA_ATTEMPTS


@pytest.mark.integration
async def test_any_other_refusal_fails_the_medium_at_once(vertex: Vertex) -> None:
    fake, handlers = vertex
    path = vertex_path("global", MUSIC_MODEL, "generateContent")
    handlers[path] = gemini_error(400, "INVALID_ARGUMENT")

    with pytest.raises(genai_errors.ClientError, match="INVALID_ARGUMENT"):
        await (await models_at(fake)).music("a track")
    assert [received for received, _ in fake.received].count(path) == 1


@pytest.mark.integration
async def test_a_storyboard_answered_in_words_only_fails(vertex: Vertex) -> None:
    fake, handlers = vertex
    handlers[vertex_path("global", STORYBOARD_MODEL, "generateContent")] = vertex_text_only

    with pytest.raises(RuntimeError, match="image"):
        await (await models_at(fake)).storyboard("a card")


@pytest.mark.integration
async def test_lyria_answers_with_a_track(vertex: Vertex) -> None:
    fake, handlers = vertex
    path = vertex_path("global", MUSIC_MODEL, "generateContent")
    handlers[path] = vertex_inline("audio/mpeg", b"ID3")

    assert await (await models_at(fake)).music("a track") == (b"ID3", "audio/mpeg")
    _, request = _request(fake, path)
    assert request.generationConfig == {"responseModalities": ["AUDIO", "TEXT"]}


@pytest.mark.integration
async def test_veo_is_polled_until_its_clip_is_ready(vertex: Vertex) -> None:
    fake, handlers = vertex
    start = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "predictLongRunning")
    poll = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "fetchPredictOperation")
    handlers[start] = veo_started(PREVIEW_MODEL)
    handlers[poll] = veo_polls(PREVIEW_MODEL, VEO_RUNNING, veo_done(b"mp4"))

    assert await (await models_at(fake)).preview("a clip", 4) == (b"mp4", "video/mp4")
    _, request = _request(fake, start)
    assert request.parameters == {
        "aspectRatio": "9:16",
        "durationSeconds": 4,
        "resolution": "720p",
        "sampleCount": 1,
        "generateAudio": False,
        "personGeneration": "allow_adult",
        "negativePrompt": seed_media.PREVIEW_NEGATIVE_PROMPT,
    }
    assert [path for path, _ in fake.received].count(poll) == 2


@pytest.mark.integration
@pytest.mark.parametrize(
    ("outcome", "match"), [(veo_failed("quota"), "quota"), (VEO_FILTERED, "no video: .*why")]
)
async def test_a_clip_veo_fails_or_filters_out_fails(
    vertex: Vertex, outcome: Reply, match: str
) -> None:
    fake, handlers = vertex
    start = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "predictLongRunning")
    poll = vertex_path(PREVIEW_LOCATION, PREVIEW_MODEL, "fetchPredictOperation")
    handlers[start] = veo_started(PREVIEW_MODEL)
    handlers[poll] = veo_polls(PREVIEW_MODEL, outcome)

    with pytest.raises(RuntimeError, match=match):
        await (await models_at(fake)).preview("a clip", 6)


async def test_connect_vertex_needs_the_cloud_project() -> None:
    with patch.dict(os.environ, {}, clear=True):
        settings = Settings.model_validate(
            {key: value for key, value in _env().items() if key != "GOOGLE_CLOUD_PROJECT"}
        )

    with pytest.raises(ValueError, match="GOOGLE_CLOUD_PROJECT"):
        await connect_vertex(settings, "seed-bucket", token_command=PRINTS_A_TOKEN)


async def test_connect_vertex_uploads_to_the_bucket_as_the_gcloud_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    uploaded: Uploaded = []
    clients: list[tuple[str, Credentials]] = []
    monkeypatch.setattr(seed_media.storage, "Client", storage_client(uploaded, clients))

    models, upload = await connect_vertex(
        settings_for(), "seed-bucket", token_command=PRINTS_A_TOKEN
    )
    await upload("seed-media/x/music.mp3", b"track", "audio/mpeg")

    assert isinstance(models, VertexMediaModels)
    [(project, credentials)] = clients
    assert project == VERTEX_PROJECT
    assert isinstance(credentials, UserCredentials)
    assert uploaded == [("seed-bucket", "seed-media/x/music.mp3", b"track", "audio/mpeg")]


@pytest.mark.integration
def test_the_command_dry_runs_against_the_committed_seed_file() -> None:
    """`python -m scripts.seed_media` (what `bun run --filter @repo/ai seeds:media`
    runs, from apps/ai), as a dry run: it plans against the committed seed file and
    leaves it exactly as it was."""
    committed = TEMPLATES_PATH.read_bytes()

    run = subprocess.run(
        [sys.executable, "-m", "scripts.seed_media", "--bucket", "seed-bucket", "--dry-run"],
        cwd=APP_ROOT,
        env={**os.environ, **_env(), "LOG_LEVEL": "info"},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert run.returncode == 0, run.stderr
    assert "estimated" in run.stdout
    assert TEMPLATES_PATH.read_bytes() == committed
