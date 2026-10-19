"""Director against real Postgres and Redis, with a local Gemini API that speaks its real
protocol (tests/fakes.py): plans, the library and its one-short-per-member limit, scene
checks, takes and their reviews, cuts, budgets, every way a model call can fail, tenancy,
and the worker's dispatch."""

import asyncio
import base64
import contextlib
import os
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Generator, Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import httpx2 as httpx
import jwt
import pytest
import structlog
from fastapi.testclient import TestClient
from httpx import AsyncClient as HttpClient
from psycopg.types.json import Jsonb
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import IntegrityError

from app import analytics
from app.db.models import DirectorPlan
from app.director import (
    Budgets,
    Director,
    ReviewInterrupted,
    create_director_model,
    index_lock_key,
)
from app.errors import AppError
from app.indexing import PLANNER_RETRIES, IndexFailed, Watched
from app.queues import DirectorQueue, JobLike
from app.schemas import (
    DirectorCutOut,
    DirectorLibraryOut,
    DirectorPlanOut,
    DirectorTakeOut,
    IndexRequest,
    IndexResult,
    Located,
    PublishCopy,
    ReviseResult,
)
from app.session_recordings import create_session_pass
from app.settings import get_settings
from app.usage import Allowance
from app.worker import director_processor, review_processor
from tests.fakes import (
    BIGQUERY_DATASET,
    BIGQUERY_PROJECT,
    GCS_UPLOAD,
    GEMINI_MODEL,
    GEMINI_PATH,
    INSERT_ALL,
    MEDIA_BUCKET,
    Fake,
    Identity,
    Reply,
    bigquery_client,
    bigquery_inserted,
    gcs_uploaded,
    gemini_error,
    gemini_output,
    inserted_rows,
    serve,
    serve_files,
    serve_identity,
)
from tests.support import (
    ENV,
    as_org,
    error_of,
    headers,
    migrator,
    new_org,
    on_app_loop,
    published,
    redis_client,
    stored_job,
    subscribe,
)

pytestmark = pytest.mark.integration

VIDEO = "dQw4w9WgXcQ"
# A real JPEG's first bytes, then filler: the service checks the signature, Gemini (the
# fake) the rest.
FRAME = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 200).decode()

STEP: dict[str, object] = {
    "atSeconds": 0,
    "instruction": "Put on your top.",
    "cameraMove": "static",
}
FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
ANGLE: dict[str, object] = {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"}
PLAN: dict[str, object] = {
    "title": "Get ready with me",
    "format": "GRWM",
    "summary": "An outfit built piece by piece, then the full look.",
    "audio": "speech-and-music",
    "durationSeconds": 12,
    "assets": [],
    "edits": [],
    "brands": [],
    "shots": [
        {
            "kind": "video",
            "mode": "on-camera",
            "title": "The top",
            "purpose": "Shows the first piece.",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 4,
            "durationSeconds": 4,
            "camera": "back",
            "scene": "In front of a mirror",
            "sceneLandmark": "mirror",
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {
                "description": "Standing, arms relaxed.",
                "keypoints": [{"name": "nose", "x": 0.5, "y": 0.15}],
            },
            "steps": [STEP],
            "script": [{"startSeconds": 0, "endSeconds": 2, "text": "First, the top."}],
        },
        {
            "kind": "photo",
            "mode": "on-camera",
            "title": "The full look",
            "purpose": "The finished outfit, still.",
            "sourceStartSeconds": 10,
            "sourceEndSeconds": 12,
            "durationSeconds": 2,
            "camera": "back",
            "scene": "Anywhere with light",
            "sceneLandmark": None,
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {"description": "Hand on hip.", "keypoints": []},
            "steps": [{**STEP, "instruction": "Strike a pose."}],
            "script": [],
        },
    ],
}
# No one in the shot at all: an object (the pan) is the whole subject.
NO_PERSON_PLAN: dict[str, object] = {
    "title": "5-minute pasta",
    "format": "recipe",
    "summary": "A quick pasta, from pan to plate.",
    "audio": "music",
    "durationSeconds": 6,
    "assets": [],
    "edits": [],
    "brands": [],
    "shots": [
        {
            "kind": "video",
            "mode": "on-camera",
            "title": "The pan",
            "purpose": "setup: the ingredients go in, simple and inviting",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 6,
            "durationSeconds": 6,
            "camera": "back",
            "scene": "At the stove",
            "sceneLandmark": "stove",
            "framing": {
                "shotSize": "close-up",
                "subject": {"x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6},
                "note": "The pan fills the frame.",
            },
            "phoneAngle": {"pitch": -60, "roll": 0, "tolerance": 10, "height": "overhead"},
            "pose": {"description": "No one in frame.", "keypoints": []},
            "steps": [
                {"atSeconds": 0, "instruction": "Put the pan on the stove.", "cameraMove": "static"}
            ],
            "script": [],
        }
    ],
}
# Nobody speaks; the story is told by on-screen captions, carried as script lines.
NO_SPEECH_PLAN: dict[str, object] = {
    "title": "3 tips for faster mornings",
    "format": "listicle",
    "summary": "Three on-screen tips, no voice at all.",
    "audio": "none",
    "durationSeconds": 6,
    "assets": [],
    "edits": [],
    "brands": [],
    "shots": [
        {
            "kind": "video",
            "mode": "on-camera",
            "title": "Tip one",
            "purpose": "hook: the first tip, on screen only",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 6,
            "durationSeconds": 6,
            "camera": "front",
            "scene": "In the kitchen",
            "sceneLandmark": None,
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {
                "description": "Standing, pointing at the caption.",
                "keypoints": [{"name": "nose", "x": 0.5, "y": 0.2}],
            },
            "steps": [
                {
                    "atSeconds": 0,
                    "instruction": 'Show the caption "Tip 1: Prep the night before".',
                    "cameraMove": "static",
                }
            ],
            "script": [
                {"startSeconds": 0, "endSeconds": 3, "text": "Tip 1: Prep the night before"}
            ],
        }
    ],
}
REVIEW: dict[str, object] = {
    "bestStartSeconds": 1.25,
    "bestEndSeconds": 4.5,
    "score": 82,
    "feedback": "Great framing; hold the last pose a beat longer.",
    "reason": "The cleanest delivery, and you held the smile.",
    "index": {
        "visible": "A woman in a blue jumper at a kitchen counter, smiling at the camera.",
        "things": ["blue jumper", "kitchen counter"],
        "transcript": [{"text": "Tip", "startSeconds": 1.3, "endSeconds": 1.6}],
        "moments": [{"kind": "smile", "atSeconds": 4.2, "note": "big smile at the camera"}],
        "quality": {"sharpness": "sharp", "shake": "steady", "exposure": "good", "audio": "clear"},
    },
}

_TAKES = TypeAdapter(list[DirectorTakeOut])


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    """The Gemini API; a test swaps what it answers with through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {GEMINI_PATH: gemini_output(PLAN)}
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]) -> dict[str, str]:
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        # Indexing (app/director.py's planner) uses its own models; the fake only answers
        # one path, so both point at it too, same as DIRECTOR_MODEL.
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }


def director() -> Director:
    from app.main import services

    found = services().director
    assert found is not None
    return found


def plan_of(client: TestClient, org: UUID, user: UUID) -> DirectorPlanOut:
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def index(client: TestClient, org: UUID, user: UUID, video: str = VIDEO) -> httpx.Response:
    return client.post("/v1/director/plans", json={"videoId": video}, headers=headers(org, user))


def index_plan(client: TestClient, org: UUID, user: UUID, video: str = VIDEO) -> DirectorPlanOut:
    response = index(client, org, user, video)
    assert response.status_code == 200, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def library(client: TestClient, org: UUID, user: UUID) -> DirectorLibraryOut:
    response = client.get("/v1/director/library", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return DirectorLibraryOut.model_validate_json(response.content)


def insert_plan(
    org: UUID,
    video: str,
    *,
    source: str = "seed",
    status: str = "ready",
    created_by: UUID | None = None,
) -> UUID:
    """A plan written straight to the database, as a seeded template is copied in."""
    [(plan_id,)] = as_org(
        org,
        """INSERT INTO ai.director_plan
             (org_id, created_by, video_id, source, status, stage, plan, model, updated_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s, 'seed-model', now())
           RETURNING id""",
        (org, created_by, video, source, status, status, Jsonb(PLAN)),
    )
    assert isinstance(plan_id, UUID)
    return plan_id


def ready_plan(client: TestClient, org: UUID, user: UUID) -> DirectorPlanOut:
    plan = index_plan(client, org, user)
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    return plan_of(client, org, user)


def new_file(user: UUID, purpose: str = "director-take-video") -> UUID:
    """A ready upload of the user's, as apps/api and the worker would have left it."""
    file_id = uuid4()
    with migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.user_id', %s, true)", (str(user),))
        db.execute(
            """INSERT INTO files.file
                 (id, user_id, purpose, status, filename, declared_type, declared_size, updated_at)
               VALUES (%s, %s, %s, 'ready', 'take', 'video/webm', 10, now())""",
            (file_id, user, purpose),
        )
    return file_id


def add_take(
    client: TestClient,
    org: UUID,
    user: UUID,
    source_url: str,
    *,
    shot: int = 0,
    kind: str = "video",
    content_type: str = "video/webm",
) -> DirectorTakeOut:
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": shot,
            "fileId": str(new_file(user)),
            "kind": kind,
            "contentType": content_type,
            "sourceUrl": source_url,
        },
        headers=headers(org, user),
    )
    assert response.status_code == 201, response.text
    return DirectorTakeOut.model_validate_json(response.content)


def takes_of(client: TestClient, org: UUID, user: UUID) -> list[DirectorTakeOut]:
    response = client.get(f"/v1/director/plans/{VIDEO}/takes", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return _TAKES.validate_json(response.content)


def usage(org: UUID, feature: str) -> int:
    rows = as_org(
        org,
        "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage WHERE feature = %s",
        (feature,),
    )
    [(total,)] = rows
    assert isinstance(total, int)
    return total


def usage_models(org: UUID, feature: str) -> set[str]:
    """Every distinct model a feature's usage rows (the reservation and its settling)
    were recorded under, for the organization."""
    rows = as_org(org, "SELECT DISTINCT model FROM ai.usage WHERE feature = %s", (feature,))
    models: set[str] = set()
    for (model,) in rows:
        assert isinstance(model, str)
        models.add(model)
    return models


def spend_the_month(org: UUID) -> None:
    """Uses up the workspace's monthly allowance (AI_MONTHLY_TOKENS_PER_ORG in the tests)."""
    _ = as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', 2000000, 0)",
        (org,),
    )


# ------------------------------------------------------------------------------- plans


def test_indexing_a_short_queues_its_analysis_once(client: TestClient) -> None:
    org, user = new_org()
    events = subscribe(f"realtime:org:{org}")
    plan = index_plan(client, org, user)
    assert (plan.videoId, plan.status, plan.plan) == (VIDEO, "pending", None)
    assert (plan.source, plan.stage, plan.audioStatus, plan.audioKey) == (
        "user",
        "queued",
        "none",
        None,
    )
    job_id = f"{plan.id}-{round(plan.updatedAt.timestamp() * 1000)}"
    job = stored_job(f"{{ai-director}}:ai-director:{job_id}")
    assert job[b"name"] == b"plan"
    assert published(events) == [{"type": "director.changed"}]
    # Asking again, or from another member, changes nothing and queues nothing.
    again = index_plan(client, org, uuid4())
    assert again.id == plan.id
    assert published(events) == []


def stage_of(org: UUID, plan_id: UUID) -> object:
    """The plan's stage as stored right now (read from a fake's handler, mid-call)."""
    [(stage,)] = as_org(org, "SELECT stage FROM ai.director_plan WHERE id = %s", (plan_id,))
    return stage


def test_the_analysis_watches_the_short_and_stores_the_plan(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    queued = index_plan(client, org, user)
    stages: list[object] = []

    def watched(sent: bytes) -> Reply:
        stages.append(stage_of(org, queued.id))
        return gemini_output(PLAN)(sent)

    gemini[1][GEMINI_PATH] = watched
    events = subscribe(f"realtime:org:{org}")
    on_app_loop(client, lambda: director().analyze(org, queued.id, user))
    plan = plan_of(client, org, user)
    # Each stage is stored and announced: watching while Gemini watches the short, then
    # writing once it has answered, then ready.
    assert stages == ["watching"]
    assert published(events) == [{"type": "director.changed"}] * 3
    assert (plan.status, plan.stage) == ("ready", "ready")
    # No MEDIA_BUCKET here: the original audio isn't captured.
    assert (plan.audioStatus, plan.audioKey) == ("none", None)
    assert plan.model == GEMINI_MODEL
    assert plan.plan is not None
    assert [shot.kind for shot in plan.plan.shots] == ["video", "photo"]
    [(path, sent)] = gemini[0].received
    assert path == GEMINI_PATH
    # Gemini watches the video from its URL; it is never downloaded here.
    assert b'"file_uri": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"' in sent
    # fps and the resolution hint reach the request (pydantic-ai's VideoUrl.vendor_metadata
    # and GoogleModelSettings.google_video_resolution).
    assert b'"videoMetadata": {"fps": 3.0}' in sent
    assert b'"mediaResolution": "MEDIA_RESOLUTION_MEDIUM"' in sent
    # No array bound anywhere in the schema: Vertex AI answers 400 INVALID_ARGUMENT to a
    # ShotPlan schema that has one (see app/plan_repair.py's module comment).
    assert b"minItems" not in sent
    assert b"maxItems" not in sent
    assert usage(org, "director-plan") == 1_000
    # A ready plan isn't analyzed again, nor queued again when asked for.
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert len(gemini[0].received) == 1
    assert index_plan(client, org, user).status == "ready"


def test_a_plan_with_no_one_in_it_is_accepted(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """An object (a pan, a product, a view) can be the whole subject: empty keypoints and
    an object-framed shot are a valid plan, not a broken one."""
    gemini[1][GEMINI_PATH] = gemini_output(NO_PERSON_PLAN)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert plan.status == "ready"
    assert plan.plan is not None
    [shot] = plan.plan.shots
    assert shot.pose.keypoints == []
    assert shot.camera == "back"


def test_a_plan_with_no_speech_is_accepted(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """Nobody has to speak: on-screen text carrying the story, transcribed into script, is
    a valid plan too."""
    gemini[1][GEMINI_PATH] = gemini_output(NO_SPEECH_PLAN)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert plan.status == "ready"
    assert plan.plan is not None
    assert plan.plan.audio == "none"
    [shot] = plan.plan.shots
    assert [line.text for line in shot.script] == ["Tip 1: Prep the night before"]


@contextmanager
def _client_with_env(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> Generator[TestClient]:
    """A fresh client under exactly `ENV` plus `env`, for a test whose settings can't vary
    through `extra_env` alone (a distinct fallback model, Vertex AI)."""
    for key, value in {**ENV, **env}.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    redis_client().flushdb()  # pyright: ignore[reportUnknownMemberType]  # untyped options
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


def _client_with_index_fallback(
    monkeypatch: pytest.MonkeyPatch, gemini_url: str, fallback_model: str
) -> AbstractContextManager[TestClient]:
    """A client whose INDEX_FALLBACK_MODEL is distinct from INDEX_MODEL and
    DIRECTOR_MODEL (both GEMINI_MODEL, as `extra_env`'s are), so a retry/fallback test can
    tell which model actually answered."""
    return _client_with_env(
        monkeypatch,
        {
            "DIRECTOR_MODEL": GEMINI_MODEL,
            "INDEX_MODEL": GEMINI_MODEL,
            "INDEX_FALLBACK_MODEL": fallback_model,
            "GOOGLE_API_KEY": "test-key",
            "GOOGLE_BASE_URL": gemini_url,
        },
    )


def test_the_planner_retries_then_falls_back_to_the_index_fallback_model(
    monkeypatch: pytest.MonkeyPatch, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """INDEX_MODEL's video calls fail intermittently; a transient failure is retried on it
    a couple of times before the plan falls back to INDEX_FALLBACK_MODEL, rather than
    failing a plan job over one bad response. The plan is stored under whichever model
    answered (the fallback here); the reservation, taken before either has run, is always
    under the index model."""
    fallback_model = "gemini-fallback-test"
    fallback_path = f"/v1beta/models/{fallback_model}:generateContent"
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    gemini[1][fallback_path] = gemini_output(PLAN)
    with _client_with_index_fallback(monkeypatch, gemini[0].url, fallback_model) as test_client:
        org, user = new_org()
        plan = ready_plan(test_client, org, user)

    assert plan.status == "ready"
    assert plan.model == fallback_model
    assert usage_models(org, "director-plan") == {GEMINI_MODEL}
    paths = [path for path, _ in gemini[0].received]
    # Every attempt on the primary model (the initial try plus PLANNER_RETRIES), then one
    # on the fallback, which is the one that actually answers.
    assert paths.count(GEMINI_PATH) == PLANNER_RETRIES + 1
    assert paths.count(fallback_path) == 1


def test_a_refusal_about_the_model_falls_back_without_retrying(
    monkeypatch: pytest.MonkeyPatch, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """A 401, or a 403/404 whose body isn't about the video, means the model (or the key
    it's configured with) refused, not the video: worth the fallback straight away, with
    no retry first, since retrying the same model and key wouldn't change the answer."""
    fallback_model = "gemini-fallback-test"
    fallback_path = f"/v1beta/models/{fallback_model}:generateContent"
    gemini[1][GEMINI_PATH] = gemini_error(404, "NOT_FOUND", "The requested model was not found.")
    gemini[1][fallback_path] = gemini_output(PLAN)
    with _client_with_index_fallback(monkeypatch, gemini[0].url, fallback_model) as test_client:
        org, user = new_org()
        plan = ready_plan(test_client, org, user)

    assert plan.status == "ready"
    assert plan.model == fallback_model
    paths = [path for path, _ in gemini[0].received]
    assert paths.count(GEMINI_PATH) == 1  # no retry on the primary
    assert paths.count(fallback_path) == 1


def test_indexing_on_vertex_addresses_the_model_by_its_resource_name(
    monkeypatch: pytest.MonkeyPatch, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """An API key drops the project/location from the request unless the model is
    addressed by its full resource name (task 2.1.1b-brief.md's "Why"); the plan and the
    usage ledger still record INDEX_MODEL's short name, never the resource path."""
    vertex_path = (
        "/v1beta1/projects/test-project/locations/global/publishers/google/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    gemini[1][vertex_path] = gemini_output(PLAN)
    with _client_with_env(
        monkeypatch,
        {
            "DIRECTOR_MODEL": GEMINI_MODEL,
            "INDEX_MODEL": GEMINI_MODEL,
            "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
            "GOOGLE_API_KEY": "test-key",
            "GOOGLE_BASE_URL": gemini[0].url,
            "GOOGLE_VERTEX": "true",
            "GOOGLE_CLOUD_PROJECT": "test-project",
        },
    ) as test_client:
        org, user = new_org()
        plan = ready_plan(test_client, org, user)

    assert plan.status == "ready"
    assert plan.model == GEMINI_MODEL
    assert usage_models(org, "director-plan") == {GEMINI_MODEL}
    paths = [path for path, _ in gemini[0].received]
    assert paths.count(vertex_path) == 1
    # Never GEMINI_PATH: that's the Gemini API's path (`v1beta`, the bare name), not
    # Vertex's (`v1beta1`, the full resource name).
    assert GEMINI_PATH not in paths


def fake_yt_dlp(directory: Path, *, exit_code: int = 0) -> str:
    """A PATH with a stand-in `yt-dlp` first: it writes the audio file where it's told to
    (-o), as the real one would, or exits with `exit_code` without writing anything."""
    script = directory / "yt-dlp"
    script.write_text(
        f"#!{sys.executable}\n"
        "import pathlib, sys\n"
        f"if {exit_code}:\n"
        f"    sys.exit({exit_code})\n"
        "args = sys.argv[1:]\n"
        'out = args[args.index("-o") + 1].replace("%(ext)s", "m4a")\n'
        'pathlib.Path(out).write_bytes(b"original audio")\n'
    )
    script.chmod(0o755)
    return f"{directory}{os.pathsep}{os.environ['PATH']}"


def test_the_short_s_audio_is_captured_while_the_plan_is_written(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, extra_env: dict[str, str]
) -> None:
    stages: list[object] = []
    handlers: dict[str, Callable[[bytes], Reply]] = {}
    with serve(handlers) as storage:
        monkeypatch.setenv("PATH", fake_yt_dlp(tmp_path))
        monkeypatch.setenv("STORAGE_EMULATOR_HOST", storage.url)
        with _client_with_env(monkeypatch, {**extra_env, "MEDIA_BUCKET": MEDIA_BUCKET}) as test:
            org, user = new_org()
            queued = index_plan(test, org, user)

            def uploaded(sent: bytes) -> Reply:
                stages.append(stage_of(org, queued.id))
                return gcs_uploaded(sent)

            handlers[GCS_UPLOAD] = uploaded
            on_app_loop(test, lambda: director().analyze(org, queued.id, user))
            plan = plan_of(test, org, user)
    # After Gemini has answered: the plan is being written up.
    assert stages == ["writing"]
    assert (plan.status, plan.audioStatus, plan.audioKey) == (
        "ready",
        "ready",
        f"audio/{VIDEO}.m4a",
    )
    # Only the upload: the client also reads the bucket itself.
    [sent] = [sent for path, sent in storage.received if path.startswith("/upload/")]
    assert b'"name": "audio/dQw4w9WgXcQ.m4a"' in sent
    assert b"original audio" in sent


def test_audio_that_can_t_be_fetched_still_leaves_a_ready_plan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, extra_env: dict[str, str]
) -> None:
    monkeypatch.setenv("PATH", fake_yt_dlp(tmp_path, exit_code=1))
    with _client_with_env(monkeypatch, {**extra_env, "MEDIA_BUCKET": MEDIA_BUCKET}) as test:
        org, user = new_org()
        plan = ready_plan(test, org, user)
    assert (plan.status, plan.audioStatus, plan.audioKey) == ("ready", "failed", None)


def test_a_plan_nobody_asked_for_is_not_found(client: TestClient) -> None:
    org, user = new_org()
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(org, user))
    assert (response.status_code, error_of(response).code) == (404, "DIRECTOR_PLAN_NOT_FOUND")
    # And a job for a plan that's gone does nothing.
    on_app_loop(client, lambda: director().analyze(org, uuid4(), user))


def test_another_workspace_never_sees_a_plan(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    other, member = new_org()
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(other, member))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"


@pytest.mark.parametrize(
    ("status", "reason", "message"),
    [
        (403, "PERMISSION_DENIED", "The video is private."),
        (403, "PERMISSION_DENIED", "The YouTube video is age-restricted."),
        (404, "NOT_FOUND", "The video was removed or does not exist."),
        (400, "INVALID_ARGUMENT", "Cannot fetch content from the provided file_uri."),
    ],
    ids=["private", "age-restricted", "removed", "unreadable url"],
)
def test_a_video_gemini_may_not_watch_fails_without_retrying(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    status: int,
    reason: str,
    message: str,
) -> None:
    """[RF 1] What YouTube's API still lists but Gemini can't watch (private, removed,
    age-restricted) fails with the reason the member is shown for a link that's no good."""
    gemini[1][GEMINI_PATH] = gemini_error(status, reason, message)
    org, user = new_org()
    events = subscribe(f"realtime:org:{org}")
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.stage, plan.error) == (
        "failed",
        "failed",
        "DIRECTOR_VIDEO_UNAVAILABLE",
    )
    # Announced as it starts watching and as it fails.
    assert published(events)[-2:] == [{"type": "director.changed"}] * 2
    # About the video, not the model: neither retried nor sent to the fallback.
    assert len(gemini[0].received) == 1


def test_a_refusal_that_isn_t_about_the_video_is_this_service_s_failure(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(400, "INVALID_ARGUMENT", "API key not valid.")
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "DIRECTOR_ANALYSIS_FAILED")


def test_an_outage_before_the_last_attempt_leaves_the_plan_analyzing_for_the_retry(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    org, user = new_org()
    plan = index_plan(client, org, user)
    with pytest.raises(Exception, match="503"):
        on_app_loop(client, lambda: director().analyze(org, plan.id, user, final=False))
    assert plan_of(client, org, user).status == "analyzing"


def test_an_outage_fails_the_plan_for_a_retry_and_asking_again_requeues_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(500, "INTERNAL")
    org, user = new_org()
    plan = index_plan(client, org, user)
    with pytest.raises(Exception, match="500"):
        on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert (plan_of(client, org, user).status, plan_of(client, org, user).error) == (
        "failed",
        "DIRECTOR_ANALYSIS_FAILED",
    )
    retried = index_plan(client, org, user)
    assert (retried.status, retried.stage, retried.error) == ("pending", "queued", None)
    job = stored_job(
        f"{{ai-director}}:ai-director:{plan.id}-{round(retried.updatedAt.timestamp() * 1000)}"
    )
    assert job[b"name"] == b"plan"


def test_an_answer_that_breaks_the_plan_s_contract_fails_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_output({"title": "No shots"})
    org, user = new_org()
    plan = index_plan(client, org, user)
    # Not retried: another try would break it the same way, at the same cost.
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert plan_of(client, org, user).error == "DIRECTOR_ANALYSIS_FAILED"


def test_no_budget_left_fails_the_plan(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    spend_the_month(org)
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "AI_BUDGET_EXCEEDED")
    assert gemini[0].received == []


def test_a_short_that_needs_more_than_a_plan_may_spend_fails_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_output(PLAN, tokens=10_000_000)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "DIRECTOR_ANALYSIS_FAILED")
    # What it used is counted all the same.
    assert usage(org, "director-plan") == 10_000_000


# ------------------------------------------------------------------------------- the indexer

REMOTE_USAGE = {"inputTokens": 4_000, "outputTokens": 500}
# DIRECTOR_TOKENS_PER_PLAN in the tests (.env.example's): what a plan reserves.
PLAN_TOKENS = 200_000
INDEXED: dict[str, object] = {
    "plan": PLAN,
    "model": "gemini-on-cloud-run",
    "audio": {"status": "ready", "objectKey": f"audio/{VIDEO}.m4a"},
    "usage": REMOTE_USAGE,
    # The worker's own release in the tests (RELEASE unset).
    "release": "dev",
}


def error_body(code: str, status: int, params: dict[str, object]) -> dict[str, object]:
    """An error as this service answers one (app/errors.py)."""
    return {
        "defined": True,
        "code": code,
        "status": status,
        "message": code,
        "data": {"params": params},
    }


@pytest.fixture
def identity(monkeypatch: pytest.MonkeyPatch) -> Iterator[Identity]:
    """The worker's metadata server, for its ID tokens."""
    with serve_identity() as found:
        monkeypatch.setenv("GCE_METADATA_HOST", found.host)
        yield found


@contextmanager
def _with_indexer(
    monkeypatch: pytest.MonkeyPatch, extra_env: dict[str, str]
) -> Generator[tuple[TestClient, Fake, dict[str, Callable[[bytes], Reply]]]]:
    """A client whose plans the Cloud Run indexer writes (a stand-in at INDEXER_URL)."""
    handlers: dict[str, Callable[[bytes], Reply]] = {}
    with (
        serve(handlers) as remote,
        _client_with_env(monkeypatch, {**extra_env, "INDEXER_URL": remote.url}) as test_client,
    ):
        yield test_client, remote, handlers


_CLAIMS = TypeAdapter(dict[str, object])


def test_with_an_indexer_url_the_cloud_run_indexer_writes_the_plan(
    monkeypatch: pytest.MonkeyPatch,
    extra_env: dict[str, str],
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    stages: list[object] = []
    with _with_indexer(monkeypatch, extra_env) as (test_client, remote, handlers):
        org, user = new_org()
        queued = index_plan(test_client, org, user)

        def indexed(_sent: bytes) -> Reply:
            stages.append(stage_of(org, queued.id))
            return 200, INDEXED

        handlers["/v1/index"] = indexed
        events = subscribe(f"realtime:org:{org}")
        on_app_loop(test_client, lambda: director().analyze(org, queued.id, user))
        plan = plan_of(test_client, org, user)

    [(path, sent)] = remote.received
    assert path == "/v1/index"
    assert _CLAIMS.validate_json(sent) == {
        "videoId": VIDEO,
        "orgId": str(org),
        "planId": str(queued.id),
        "maxTokens": 200_000,
    }
    # An ID token from the worker's own metadata server, for the indexer's URL.
    [authorization] = remote.authorizations
    assert authorization is not None
    assert authorization.startswith("Bearer ")
    claims = _CLAIMS.validate_python(
        jwt.decode(authorization.removeprefix("Bearer "), options={"verify_signature": False})
    )
    assert (claims["aud"], claims["email"]) == (remote.url, identity.service_account)
    assert stages == ["watching"]
    assert published(events) == [{"type": "director.changed"}] * 3
    assert (plan.status, plan.stage, plan.model) == ("ready", "ready", "gemini-on-cloud-run")
    assert (plan.audioStatus, plan.audioKey) == ("ready", f"audio/{VIDEO}.m4a")
    assert plan.plan is not None
    assert plan.plan.title == "Get ready with me"
    # What the indexer says the run used is what's counted; Gemini isn't called here.
    assert usage(org, "director-plan") == 4_500
    assert gemini[0].received == []


# The worker's ID token comes from the metadata server's stand-in.
@pytest.mark.usefixtures("identity")
@pytest.mark.parametrize("release", [None, "sha-58825810"], ids=["no release", "an older one"])
def test_an_indexer_left_on_another_release_is_used_no_more(
    monkeypatch: pytest.MonkeyPatch,
    extra_env: dict[str, str],
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    release: str | None,
) -> None:
    """The indexer is deployed by hand: one left on an older release wrote plans without
    assets. Its plan isn't kept; this worker writes it, counts both runs, and doesn't ask
    that indexer again."""
    stale = {key: value for key, value in INDEXED.items() if key != "release"}
    with _with_indexer(monkeypatch, extra_env) as (test_client, remote, handlers):
        handlers["/v1/index"] = lambda _sent: (200, {**stale, "release": release})
        org, user = new_org()
        queued = index_plan(test_client, org, user)
        on_app_loop(test_client, lambda: director().analyze(org, queued.id, user))
        plan = plan_of(test_client, org, user)
        other, someone = new_org()
        second = index_plan(test_client, other, someone)
        on_app_loop(test_client, lambda: director().analyze(other, second.id, someone))
        assert plan_of(test_client, other, someone).status == "ready"
    assert (plan.status, plan.model) == ("ready", GEMINI_MODEL)
    # The indexer's run and this worker's were both paid for.
    assert usage(org, "director-plan") == 4_500 + 1_000
    # Asked once: the second plan was written here straight away.
    assert [path for path, _ in remote.received] == ["/v1/index"]
    assert len(gemini[0].received) == 2


@pytest.mark.parametrize(
    ("status", "reply", "code", "used"),
    [
        (
            422,
            error_body("DIRECTOR_VIDEO_UNAVAILABLE", 422, {"inputTokens": 40, "outputTokens": 2}),
            "DIRECTOR_VIDEO_UNAVAILABLE",
            42,
        ),
        (
            422,
            error_body("DIRECTOR_ANALYSIS_FAILED", 422, {"inputTokens": 9_000, "outputTokens": 1}),
            "DIRECTOR_ANALYSIS_FAILED",
            9_001,
        ),
        (401, error_body("UNAUTHENTICATED", 401, {}), "DIRECTOR_ANALYSIS_FAILED", 0),
        # Cloud Run's own refusal (IAM), before the indexer: not this service's error shape.
        (403, {"error": "Forbidden"}, "DIRECTOR_ANALYSIS_FAILED", 0),
        # What it used doesn't parse (another version of the indexer): the whole
        # reservation counts, since the run's real usage is unknown.
        (
            422,
            error_body("DIRECTOR_VIDEO_UNAVAILABLE", 422, {"inputTokens": "many"}),
            "DIRECTOR_VIDEO_UNAVAILABLE",
            PLAN_TOKENS,
        ),
        # A success that isn't an IndexResult: the same, and not worth a retry either.
        (200, {}, "DIRECTOR_ANALYSIS_FAILED", PLAN_TOKENS),
    ],
    ids=[
        "video unavailable",
        "analysis failed",
        "token refused",
        "not an invoker",
        "usage unreadable",
        "result unreadable",
    ],
)
def test_a_refusal_from_the_indexer_fails_the_plan_without_a_retry(
    monkeypatch: pytest.MonkeyPatch,
    extra_env: dict[str, str],
    identity: Identity,
    status: int,
    reply: dict[str, object],
    code: str,
    used: int,
) -> None:
    with _with_indexer(monkeypatch, extra_env) as (test_client, _, handlers):
        handlers["/v1/index"] = lambda _sent: (status, reply)
        org, user = new_org()
        plan = index_plan(test_client, org, user)
        # Not the last attempt, and still not left for a retry: it would fail the same way.
        on_app_loop(test_client, lambda: director().analyze(org, plan.id, user, final=False))
        failed = plan_of(test_client, org, user)
    assert (failed.status, failed.stage, failed.error) == ("failed", "failed", code)
    assert usage(org, "director-plan") == used


@pytest.mark.parametrize(
    ("status", "reply", "used"),
    [
        (
            502,
            error_body(
                "UPSTREAM_UNAVAILABLE",
                502,
                {"service": "gemini", "inputTokens": 7, "outputTokens": 0},
            ),
            7,
        ),
        # Cloud Run's own 503 or 504 may come after the indexer started (or finished) a
        # run: its usage is unknown, so the whole reservation counts.
        (503, {"error": "Service Unavailable"}, PLAN_TOKENS),
        # Refused before reaching the indexer: nothing ran.
        (429, {"error": "Too Many Requests"}, 0),
    ],
    ids=["gemini down", "cloud run down", "cloud run busy"],
)
def test_an_indexer_outage_is_retried_then_fails_the_plan(
    monkeypatch: pytest.MonkeyPatch,
    extra_env: dict[str, str],
    identity: Identity,
    status: int,
    reply: dict[str, object],
    used: int,
) -> None:
    with _with_indexer(monkeypatch, extra_env) as (test_client, _, handlers):
        handlers["/v1/index"] = lambda _sent: (status, reply)
        org, user = new_org()
        plan = index_plan(test_client, org, user)
        with pytest.raises(IndexFailed):
            on_app_loop(test_client, lambda: director().analyze(org, plan.id, user, final=False))
        assert plan_of(test_client, org, user).status == "analyzing"
        with pytest.raises(IndexFailed):
            on_app_loop(test_client, lambda: director().analyze(org, plan.id, user))
        failed = plan_of(test_client, org, user)
    assert (failed.status, failed.error) == ("failed", "DIRECTOR_ANALYSIS_FAILED")
    assert usage(org, "director-plan") == used * 2


def test_an_indexer_or_metadata_server_that_can_t_be_reached_is_retried(
    monkeypatch: pytest.MonkeyPatch, extra_env: dict[str, str], identity: Identity
) -> None:
    # Nothing listens on port 9: the connection is refused.
    with _client_with_env(monkeypatch, {**extra_env, "INDEXER_URL": "http://127.0.0.1:9"}) as test:
        org, user = new_org()
        plan = index_plan(test, org, user)
        with pytest.raises(IndexFailed):
            on_app_loop(test, lambda: director().analyze(org, plan.id, user, final=False))
        monkeypatch.setenv("GCE_METADATA_HOST", "127.0.0.1:9")
        with pytest.raises(IndexFailed):
            on_app_loop(test, lambda: director().analyze(org, plan.id, user, final=False))
        assert plan_of(test, org, user).status == "analyzing"
    # Neither request reached the indexer: nothing ran, nothing counts.
    assert usage(org, "director-plan") == 0


@contextmanager
def _hanging_up() -> Generator[str]:
    """An indexer that reads the request and closes the connection without answering (it
    crashed mid-run): what it did, and used, is unknown."""
    listener = socket.create_server(("127.0.0.1", 0))

    def accept() -> None:
        with contextlib.suppress(OSError):
            while True:
                with listener.accept()[0] as connection:
                    _ = connection.recv(65536)

    threading.Thread(target=accept, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        listener.close()


def test_an_indexer_that_hangs_up_mid_run_counts_the_whole_reservation(
    monkeypatch: pytest.MonkeyPatch, extra_env: dict[str, str], identity: Identity
) -> None:
    with (
        _hanging_up() as url,
        _client_with_env(monkeypatch, {**extra_env, "INDEXER_URL": url}) as test,
    ):
        org, user = new_org()
        plan = index_plan(test, org, user)
        with pytest.raises(IndexFailed):
            on_app_loop(test, lambda: director().analyze(org, plan.id, user, final=False))
        assert plan_of(test, org, user).status == "analyzing"
    assert usage(org, "director-plan") == PLAN_TOKENS


class _Broken:
    """An indexer with a bug: it gets as far as Gemini's answer, then fails in a way no
    IndexFailed describes (the kind of thing a database error in a stage update is)."""

    async def index(self, request: IndexRequest, *, watched: Watched) -> IndexResult:
        await watched()
        raise RuntimeError(f"a bug indexing {request.videoId}")


def _broken_director() -> Director:
    """The service's own Director, its indexer swapped for one with a bug."""
    from app.main import services

    settings = get_settings()
    model = create_director_model(settings)
    assert model is not None
    return Director(
        model,
        GEMINI_MODEL,
        _Broken(),
        GEMINI_MODEL,
        Budgets(
            monthly=Allowance(2_000_000, 300_000),
            per_plan=PLAN_TOKENS,
            per_locate=12_000,
            per_review=120_000,
            per_publish_copy=20_000,
        ),
        DirectorQueue(str(settings.redis_url)),
        services().redis,
        HttpClient(),
        None,
    )


def test_an_unexpected_failure_fails_the_plan_on_the_last_attempt(client: TestClient) -> None:
    """Whatever goes wrong, a plan never stays `analyzing` (still counting as the member's
    one short) once its last attempt is over."""
    org, user = new_org()
    plan = index_plan(client, org, user)
    broken = _broken_director()
    with pytest.raises(RuntimeError, match="a bug"):
        on_app_loop(client, lambda: broken.analyze(org, plan.id, user, final=False))
    assert (plan_of(client, org, user).status, plan_of(client, org, user).stage) == (
        "analyzing",
        "writing",
    )
    with pytest.raises(RuntimeError, match="a bug"):
        on_app_loop(client, lambda: broken.analyze(org, plan.id, user))
    failed = plan_of(client, org, user)
    assert (failed.status, failed.stage, failed.error) == (
        "failed",
        "failed",
        "DIRECTOR_ANALYSIS_FAILED",
    )
    # Its usage unknown, each attempt counts its whole reservation.
    assert usage(org, "director-plan") == 2 * PLAN_TOKENS
    assert library(client, org, user).indexUsed is False


# ------------------------------------------------------------------------------- the library

OTHER = "Other_Short"


def test_a_member_indexes_one_short_of_their_own(client: TestClient) -> None:
    org, user = new_org()
    assert library(client, org, user).indexUsed is False
    plan = index_plan(client, org, user)
    assert library(client, org, user).indexUsed is True
    # The same short again is the same plan; another one is past the limit.
    assert index_plan(client, org, user).id == plan.id
    refused = index(client, org, user, OTHER)
    assert (refused.status_code, error_of(refused).code) == (409, "DIRECTOR_INDEX_LIMIT")
    assert [t.videoId for t in library(client, org, user).templates] == [VIDEO]


def test_a_failed_index_doesn_t_count(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """[RF 1] A short Gemini can't watch fails with its reason and leaves the member's
    one index unused."""
    gemini[1][GEMINI_PATH] = gemini_error(403, "PERMISSION_DENIED", "The video is private.")
    org, user = new_org()
    failed = ready_plan(client, org, user)
    assert (failed.status, failed.stage, failed.error) == (
        "failed",
        "failed",
        "DIRECTOR_VIDEO_UNAVAILABLE",
    )
    assert library(client, org, user).indexUsed is False
    _ = index_plan(client, org, user, OTHER)
    # Trying the failed one again would be a second short of their own.
    refused = index(client, org, user)
    assert error_of(refused).code == "DIRECTOR_INDEX_LIMIT"
    assert plan_of(client, org, user).status == "failed"


def test_two_index_requests_at_once_count_once(client: TestClient) -> None:
    """A double-click or two tabs: the same short is one plan; two different ones are one
    plan and a refusal, whichever way the race goes."""

    async def twice(
        org: UUID, user: UUID, first: str, second: str
    ) -> list[DirectorPlan | BaseException]:
        return list(
            await asyncio.gather(
                director().index(org, user, first, None),
                director().index(org, user, second, None),
                return_exceptions=True,
            )
        )

    org, user = new_org()
    same = on_app_loop(client, lambda: twice(org, user, VIDEO, VIDEO))
    plans = [plan for plan in same if isinstance(plan, DirectorPlan)]
    assert len(plans) == 2
    assert plans[0].id == plans[1].id

    other, member = new_org()
    different = on_app_loop(client, lambda: twice(other, member, VIDEO, OTHER))
    refused = [error for error in different if isinstance(error, AppError)]
    assert [error.code for error in refused] == ["DIRECTOR_INDEX_LIMIT"]
    assert len(library(client, other, member).templates) == 1


def test_a_member_s_index_requests_take_turns(client: TestClient) -> None:
    """Each request holds the member's lock for its whole claim, so a second one (a double
    click, another tab) starts only once the first has committed and sees its plan: the
    same short is answered with that plan, never refused."""
    org, user = new_org()
    portal = client.portal
    assert portal is not None
    with migrator() as db, db.transaction():
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s::text, 0))", (index_lock_key(user),)
        )
        db.execute("SELECT set_config('app.org_id', %s, true)", (str(org),))
        [first] = db.execute(
            """INSERT INTO ai.director_plan (org_id, created_by, video_id, updated_at)
               VALUES (%s, %s, %s, now()) RETURNING id""",
            (org, user, VIDEO),
        ).fetchall()
        second = portal.start_task_soon(lambda: director().index(org, user, VIDEO, None))
        _wait_for_a_lock_wait("advisory")
    plan = second.result(timeout=10)
    assert plan.id == first[0]


def test_an_index_counts_in_every_workspace(client: TestClient) -> None:
    """A member's one short of their own is one across all their workspaces."""
    org, user = new_org()
    _ = index_plan(client, org, user)
    other, _ = new_org()
    assert library(client, other, user).indexUsed is True
    refused = index(client, other, user, OTHER)
    assert error_of(refused).code == "DIRECTOR_INDEX_LIMIT"


def test_an_index_racing_another_is_refused_by_the_database(client: TestClient) -> None:
    """The check before the insert can't see another request's uncommitted plan; the
    partial unique index can, and its refusal is the same DIRECTOR_INDEX_LIMIT."""
    org, user = new_org()
    portal = client.portal
    assert portal is not None
    with migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.org_id', %s, true)", (str(org),))
        db.execute(
            """INSERT INTO ai.director_plan (org_id, created_by, video_id, updated_at)
               VALUES (%s, %s, %s, now())""",
            (org, user, OTHER),
        )
        racing = portal.start_task_soon(lambda: director().index(org, user, VIDEO, None))
        _wait_for_a_lock_wait("transactionid")
    error = racing.exception(timeout=10)
    assert isinstance(error, AppError)
    assert error.code == "DIRECTOR_INDEX_LIMIT"


def test_an_index_the_database_refuses_otherwise_is_not_the_limit(client: TestClient) -> None:
    """A user deleted while they asked (the plan's creator must exist) fails as a bug."""
    org, _ = new_org()
    with pytest.raises(IntegrityError, match="director_plan_created_by_fkey"):
        on_app_loop(client, lambda: director().index(org, uuid4(), VIDEO, None))


def _wait_for_a_lock_wait(locktype: str) -> None:
    """Until the service waits on a lock of this type that the test's transaction holds:
    one not yet granted (pg_locks, which any role may read; pg_stat_activity hides other
    roles' sessions)."""
    deadline = time.monotonic() + 10
    with migrator() as db:
        while time.monotonic() < deadline:
            row = db.execute(
                "SELECT count(*) FROM pg_locks WHERE NOT granted AND locktype = %s", (locktype,)
            ).fetchone()
            if row is not None and row[0] == 1:
                return
            time.sleep(0.05)
    raise AssertionError("the index never waited on the other plan")


def test_seeded_templates_are_in_the_library_and_count_for_no_one(client: TestClient) -> None:
    org, user = new_org()
    seed = insert_plan(org, "Seed_Short1")
    # Even one in a member's name (the index only counts their own shorts).
    _ = insert_plan(org, "Seed_Short2", created_by=user)
    shelf = library(client, org, user)
    assert [(t.videoId, t.source, t.stage) for t in shelf.templates] == [
        ("Seed_Short2", "seed", "ready"),
        ("Seed_Short1", "seed", "ready"),
    ]
    assert shelf.indexUsed is False
    # Indexing a seeded short is its plan, and still not the member's own.
    assert index_plan(client, org, user, "Seed_Short1").id == seed
    assert library(client, org, user).indexUsed is False
    plan = index_plan(client, org, user)
    assert library(client, org, user).templates[0].id == plan.id
    assert library(client, org, user).indexUsed is True
    # Another workspace sees none of it.
    other, member = new_org()
    assert library(client, other, member) == DirectorLibraryOut(templates=[], indexUsed=False)


# ------------------------------------------------------------------------------- cuts


def save_cut(
    client: TestClient,
    org: UUID,
    user: UUID,
    picks: list[tuple[int, UUID]],
    *,
    file_id: UUID | None = None,
) -> httpx.Response:
    return client.post(
        "/v1/director/cuts",
        json={
            "videoId": VIDEO,
            "title": "My look",
            "fileId": str(file_id or new_file(user, "director-cut-video")),
            "picks": [{"shotIndex": shot, "takeId": str(take)} for shot, take in picks],
        },
        headers=headers(org, user),
    )


def cuts_of(client: TestClient, org: UUID, user: UUID, path: str) -> list[DirectorCutOut]:
    response = client.get(path, headers=headers(org, user))
    assert response.status_code == 200, response.text
    return _CUTS.validate_json(response.content)


_CUTS = TypeAdapter(list[DirectorCutOut])


def test_a_cut_keeps_its_picks_and_how_long_they_last(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        reviewed = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, reviewed.id, f"{files.url}/t", user))
    unreviewed = add_take(client, org, user, "http://storage/t")
    photo = add_take(
        client, org, user, "http://storage/p", shot=1, kind="photo", content_type="image/jpeg"
    )

    # The reviewed take's best part (1.25 s to 4.5 s), then the photo's 2 seconds.
    response = save_cut(client, org, user, [(0, reviewed.id), (1, photo.id)])
    assert response.status_code == 201, response.text
    cut = DirectorCutOut.model_validate_json(response.content)
    assert (cut.videoId, cut.templateTitle, cut.title, cut.durationMs) == (
        VIDEO,
        "Get ready with me",
        "My look",
        5_250,
    )
    assert (cut.publishStatus, cut.youtubeVideoId, cut.visibility) == ("none", None, None)
    # A take not reviewed yet lasts as long as its shot (4 seconds).
    second = DirectorCutOut.model_validate_json(
        save_cut(client, org, user, [(0, unreviewed.id)]).content
    )
    assert second.durationMs == 4_000
    # A take an older review kept a tenth of a second of plays whole in the editor, so it
    # lasts its shot's length here too.
    with migrator() as db:
        db.execute(
            "UPDATE ai.director_take SET best_start_ms = 1000, best_end_ms = 1100 WHERE id = %s",
            (unreviewed.id,),
        )
    flash = DirectorCutOut.model_validate_json(
        save_cut(client, org, user, [(0, unreviewed.id)]).content
    )
    assert flash.durationMs == 4_000
    assert [c.id for c in cuts_of(client, org, user, f"/v1/director/plans/{VIDEO}/cuts")] == [
        flash.id,
        second.id,
        cut.id,
    ]
    assert [c.id for c in cuts_of(client, org, user, "/v1/director/cuts")] == [
        flash.id,
        second.id,
        cut.id,
    ]
    # Each member's cuts are their own; another workspace has none of them.
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    assert cuts_of(client, org, teammate, "/v1/director/cuts") == []
    other, member = new_org()
    assert cuts_of(client, other, member, "/v1/director/cuts") == []


def test_a_cut_s_picks_are_the_member_s_takes_of_those_shots(client: TestClient) -> None:
    org, user = new_org()
    response = save_cut(client, org, user, [(0, uuid4())])
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"
    _ = index_plan(client, org, user)
    assert error_of(save_cut(client, org, user, [(0, uuid4())])).code == "DIRECTOR_PLAN_NOT_READY"
    plan_id = plan_of(client, org, user).id
    on_app_loop(client, lambda: director().analyze(org, plan_id, user))
    take = add_take(client, org, user, "http://storage/t")
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    for picks, code in [
        ([(5, take.id)], "DIRECTOR_SHOT_NOT_FOUND"),
        ([(1, take.id)], "DIRECTOR_TAKE_NOT_FOUND"),
        ([(0, uuid4())], "DIRECTOR_TAKE_NOT_FOUND"),
        ([(0, take.id), (0, take.id)], "VALIDATION_FAILED"),
    ]:
        assert error_of(save_cut(client, org, user, picks)).code == code, picks
    # Someone else's take is never theirs to pick.
    refused = save_cut(client, org, teammate, [(0, take.id)])
    assert error_of(refused).code == "DIRECTOR_TAKE_NOT_FOUND"
    assert cuts_of(client, org, user, "/v1/director/cuts") == []


# ------------------------------------------------------------------------------- publishing


def a_cut(client: TestClient, org: UUID, user: UUID) -> DirectorCutOut:
    """A cut of the user's, of a ready plan (the take in it not reviewed yet)."""
    _ = ready_plan(client, org, user)
    take = add_take(client, org, user, "http://storage/t")
    response = save_cut(client, org, user, [(0, take.id)])
    assert response.status_code == 201, response.text
    return DirectorCutOut.model_validate_json(response.content)


def new_teammate() -> UUID:
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    return teammate


def test_a_cut_is_read_by_its_member_only(client: TestClient) -> None:
    org, user = new_org()
    cut = a_cut(client, org, user)
    response = client.get(f"/v1/director/cuts/{cut.id}", headers=headers(org, user))
    assert response.status_code == 200, response.text
    assert DirectorCutOut.model_validate_json(response.content) == cut
    teammate = new_teammate()
    other, member = new_org()
    for caller in [headers(org, teammate), headers(other, member)]:
        refused = client.get(f"/v1/director/cuts/{cut.id}", headers=caller)
        assert (refused.status_code, error_of(refused).code) == (404, "DIRECTOR_CUT_NOT_FOUND")


COPY: dict[str, object] = {
    "title": "Three looks, one mirror #Shorts",
    "description": "My take on the GRWM trend.",
    "hashtags": ["#GRWM", "fit check", "grwm"],
    "credits": "Inspired by Maya's Short, recreated with Director.",
}
ORIGINAL: dict[str, object] = {"title": "3 looks in 30 seconds", "channel": "Maya Styles"}


def publish_copy(
    client: TestClient,
    org: UUID,
    user: UUID,
    cut_id: UUID,
    original: dict[str, object] | None = ORIGINAL,
) -> httpx.Response:
    return client.post(
        "/v1/director/publish-copy",
        json={"cutId": str(cut_id), "original": original},
        headers=headers(org, user),
    )


def test_gemini_writes_the_post_for_a_cut(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    cut = a_cut(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(COPY, tokens=700)
    response = publish_copy(client, org, user, cut.id)
    assert response.status_code == 200, response.text
    assert PublishCopy.model_validate_json(response.content) == PublishCopy(
        title="Three looks, one mirror",
        description="My take on the GRWM trend.",
        hashtags=["GRWM", "fitcheck"],
        credits="Inspired by Maya's Short, recreated with Director.",
    )
    # Gemini gets the original's plan, its title and channel, and the cut's own title.
    sent = gemini[0].received[-1][1]
    for part in [b"Get ready with me", b"First, the top.", b"Maya Styles", b"My look"]:
        assert part in sent, part
    assert usage(org, "director-publish") == 700
    # Without the original (YouTube no longer shows it), from the plan alone.
    without = publish_copy(client, org, user, cut.id, original=None)
    assert without.status_code == 200, without.text
    assert b"Maya Styles" not in gemini[0].received[-1][1]


def test_a_post_is_written_only_for_the_member_s_own_cut(client: TestClient) -> None:
    org, user = new_org()
    cut = a_cut(client, org, user)
    for caller, cut_id in [(user, uuid4()), (new_teammate(), cut.id)]:
        refused = publish_copy(client, org, caller, cut_id)
        assert error_of(refused).code == "DIRECTOR_CUT_NOT_FOUND"


def test_a_post_gemini_can_t_write_is_an_upstream_failure(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    cut = a_cut(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    response = publish_copy(client, org, user, cut.id)
    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")


def test_a_post_with_no_budget_left_is_refused(client: TestClient) -> None:
    org, user = new_org()
    cut = a_cut(client, org, user)
    spend_the_month(org)
    response = publish_copy(client, org, user, cut.id)
    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")


# ------------------------------------------------------------------------------ re-planning

YOURS: dict[str, object] = {
    "notes": [{"kind": "place", "note": "Inside"}],
    "shots": [{"shot": 0, "where": "By the window"}],
    "skipped": [],
    "gaps": [],
}
REVISION: dict[str, object] = {
    "shots": [
        {
            "shot": 1,
            "status": "film",
            "title": None,
            "where": None,
            "action": None,
            "line": None,
            "framing": "Waist up",
            "camera": "front",
        },
        {
            "shot": 2,
            "status": "gap",
            "title": None,
            "where": None,
            "action": None,
            "line": None,
            "framing": None,
            "camera": None,
        },
    ],
    "summary": "Everything's from right here now.",
}


def revise(
    client: TestClient, org: UUID, user: UUID, video: str = VIDEO, instruction: str = "one angle"
) -> httpx.Response:
    return client.post(
        f"/v1/director/plans/{video}/revisions",
        json={"instruction": instruction, "version": YOURS},
        headers=headers(org, user),
    )


def test_gemini_re_plans_the_member_s_version(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVISION, tokens=900)
    response = revise(client, org, user)
    assert response.status_code == 200, response.text
    assert ReviseResult.model_validate_json(response.content) == ReviseResult.model_validate(
        {
            "version": {
                "notes": [{"kind": "place", "note": "Inside"}],
                "shots": [
                    {"shot": 0, "where": "By the window", "framing": "Waist up", "camera": "front"}
                ],
                "skipped": [],
                "gaps": [1],
            },
            "summary": "Everything's from right here now.",
        }
    )
    # Gemini reads the plan's shots, their version, what they've told Director and the
    # instruction.
    sent = gemini[0].received[-1][1]
    for part in [b"The top", b"By the window", b"place: Inside", b"one angle"]:
        assert part in sent, part
    assert usage(org, "director-revise") == 900


def test_a_re_plan_needs_a_ready_plan_and_gemini(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    missing = revise(client, org, user)
    assert error_of(missing).code == "DIRECTOR_PLAN_NOT_FOUND"
    plan = index_plan(client, org, user)
    pending = revise(client, org, user)
    assert error_of(pending).code == "DIRECTOR_PLAN_NOT_READY"
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    failed = revise(client, org, user)
    assert (failed.status_code, error_of(failed).code) == (502, "UPSTREAM_UNAVAILABLE")
    spend_the_month(org)
    broke = revise(client, org, user)
    assert (broke.status_code, error_of(broke).code) == (429, "AI_BUDGET_EXCEEDED")


# ------------------------------------------------------------------------------- marks


def locate(client: TestClient, org: UUID, user: UUID, image: str = FRAME) -> httpx.Response:
    return client.post(
        "/v1/director/locate",
        json={"target": "the window behind you", "image": image},
        headers=headers(org, user),
    )


def test_a_locate_turns_gemini_s_box_into_fractions_of_the_frame(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    gemini[1][GEMINI_PATH] = gemini_output(
        {"found": True, "label": "your window", "box_2d": [100, 250, 600, 750]}, tokens=400
    )
    response = locate(client, org, user)
    assert response.status_code == 200, response.text
    found = Located.model_validate_json(response.content)
    assert found.found
    assert found.label == "your window"
    assert found.box is not None
    assert (found.box.x, found.box.y, found.box.width, found.box.height) == (0.25, 0.1, 0.5, 0.5)
    # The frame and the target reach Gemini together.
    sent = gemini[0].received[-1][1]
    assert b'"mime_type": "image/jpeg"' in sent
    assert b"the window behind you" in sent
    assert usage(org, "director-locate") == 400


@pytest.mark.parametrize(
    "answer",
    [
        {"found": False, "label": "a fridge", "box_2d": []},
        # Found, but with no box, one that isn't four numbers, or one too thin to be a
        # thing: never drawn.
        {"found": True, "label": "a fridge", "box_2d": []},
        {"found": True, "label": "a fridge", "box_2d": [100, 100, 600]},
        {"found": True, "label": "a fridge", "box_2d": [100, 100, 105, 600]},
        {"found": True, "label": "a fridge", "box_2d": [600, 100, 100, 600]},
    ],
)
def test_what_isn_t_clearly_in_the_frame_is_not_found(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    answer: dict[str, object],
) -> None:
    org, user = new_org()
    gemini[1][GEMINI_PATH] = gemini_output(answer)
    found = Located.model_validate_json(locate(client, org, user).content)
    assert (found.found, found.box) == (False, None)


def test_a_locate_needs_a_jpeg_gemini_and_budget(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    png = base64.b64encode(b"\x89PNG" + b"\x00" * 200).decode()
    assert error_of(locate(client, org, user, image=png)).code == "VALIDATION_FAILED"
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    response = locate(client, org, user)
    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")
    spend_the_month(org)
    response = locate(client, org, user)
    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")


# ------------------------------------------------------------------------------- takes


def test_a_take_is_reviewed_and_keeps_its_best_part(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW, tokens=4_000)
    events = subscribe(f"realtime:org:{org}")
    with serve_files({"/take.webm": ("video/webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64)}) as files:
        take = add_take(client, org, user, f"{files.url}/take.webm?X-Amz-Signature=abc")
        assert take.status == "pending"
        # On the reviews' own queue, retried with a jittered backoff this service computes.
        job = stored_job(f"{{ai-review}}:ai-review:{take.id}")
        assert job[b"name"] == b"review-take"
        assert b'"type":"exponential-jitter"' in job[b"opts"]
        on_app_loop(
            client,
            lambda: director().review(
                org, take.id, f"{files.url}/take.webm?X-Amz-Signature=abc", user
            ),
        )
    [reviewed] = takes_of(client, org, user)
    assert (reviewed.status, reviewed.bestStartMs, reviewed.bestEndMs, reviewed.score) == (
        "ready",
        1_250,
        4_500,
        82,
    )
    assert reviewed.feedback == REVIEW["feedback"]
    assert reviewed.reason == REVIEW["reason"]
    [(stored,)] = as_org(org, "SELECT take_index FROM ai.director_take WHERE id = %s", (take.id,))
    assert stored == REVIEW["index"]
    assert (reviewed.chosen, reviewed.origin) == (False, "shoot")
    assert b'"mime_type": "video/webm"' in gemini[0].received[-1][1]
    assert usage(org, "director-review") == 4_000
    assert {"type": "director.changed"} in published(events)
    # Reviewed once: running the job again leaves it.
    on_app_loop(client, lambda: director().review(org, take.id, "http://unused", user))


def keep_version(org: UUID, user: UUID, version: dict[str, object]) -> None:
    """The member's version of the template, as apps/api keeps it."""
    _ = as_org(
        org,
        """INSERT INTO app.director_version (org_id, user_id, video_id, version, updated_at)
           VALUES (%s, %s, %s, %s, now())""",
        (org, user, VIDEO, Jsonb(version)),
    )


def outdoor_first_shot(org: UUID) -> None:
    """The ready plan's first shot, filmed outdoors in the original."""
    _ = as_org(
        org,
        """UPDATE ai.director_plan SET plan = jsonb_set(jsonb_set(plan,
             '{shots,0,scene}', '"Film outdoors on the street"'),
             '{shots,0,title}', '"Intro in the market"')""",
    )


INDOORS: dict[str, object] = {
    "notes": [{"kind": "place", "note": "Inside"}],
    "shots": [{"shot": 0, "title": "Intro at your desk", "where": "At your desk"}],
    "skipped": [],
    "gaps": [],
}


def reviewed_prompt(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    org: UUID,
    user: UUID,
) -> str:
    """What Gemini was sent to review a take of the first shot."""
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/take.webm": ("video/webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64)}) as files:
        url = f"{files.url}/take.webm?X-Amz-Signature=abc"
        take = add_take(client, org, user, url)
        on_app_loop(client, lambda: director().review(org, take.id, url, user))
    assert takes_of(client, org, user)[0].status == "ready"
    return gemini[0].received[-1][1].decode()


def test_a_take_is_reviewed_against_the_member_s_version_of_the_shot(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """They moved the outdoor shot to their desk: the review is told the shot as they're
    filming it and what they've told Director, never the street they left."""
    org, user = new_org()
    _ = ready_plan(client, org, user)
    outdoor_first_shot(org)
    keep_version(org, user, INDOORS)
    sent = reviewed_prompt(client, gemini, org, user)
    assert "At your desk" in sent
    assert "Intro at your desk" in sent
    assert "- place: Inside" in sent
    assert "outdoors" not in sent
    assert "Intro in the market" not in sent


def test_a_take_with_no_version_or_another_workspace_s_is_reviewed_against_the_plan(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    outdoor_first_shot(org)
    other, _ = new_org()
    keep_version(other, user, INDOORS)
    sent = reviewed_prompt(client, gemini, org, user)
    assert "Film outdoors on the street" in sent
    assert "At your desk" not in sent
    assert "(nothing yet)" in sent


def test_the_editor_reads_the_shots_as_the_member_filmed_them(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    outdoor_first_shot(org)
    keep_version(org, user, INDOORS)
    gemini[1][GEMINI_PATH] = gemini_output(
        {
            "heard": "Make it warmer",
            "outcome": "applied",
            "say": "Warmer it is.",
            "actions": [],
            "choices": [],
        }
    )
    response = client.post(
        "/v1/director/editor-requests",
        json={
            "videoId": VIDEO,
            "text": "Make it warmer",
            "audio": None,
            "audioType": None,
            "state": {"shots": [], "captions": "pop", "sound": True, "music": False, "fixes": []},
        },
        headers=headers(org, user),
    )
    assert response.status_code == 200, response.text
    sent = gemini[0].received[-1][1].decode()
    assert "Intro at your desk" in sent
    assert "Intro in the market" not in sent


def test_a_version_that_can_t_be_read_leaves_the_plan_s_shot(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    outdoor_first_shot(org)
    keep_version(org, user, {"notes": "Inside"})
    sent = reviewed_prompt(client, gemini, org, user)
    assert "Film outdoors on the street" in sent


@pytest.fixture
def bigquery(monkeypatch: pytest.MonkeyPatch) -> Iterator[Fake]:
    """Analytics on, into a stand-in BigQuery. Ask for it before `client`, so the service
    starts with the dataset set."""
    with serve({INSERT_ALL: bigquery_inserted}) as fake:
        monkeypatch.setenv("BIGQUERY_DATASET", BIGQUERY_DATASET)
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", BIGQUERY_PROJECT)
        monkeypatch.setattr(analytics, "Client", bigquery_client(fake))
        yield fake


def events_of(bigquery: Fake, kind: str) -> list[dict[str, object]]:
    """The rows of one kind the stand-in BigQuery got, once there are some: they're
    written in the background, after the work that records them has returned."""
    deadline = time.monotonic() + 10
    rows: list[dict[str, object]] = []
    while time.monotonic() < deadline and not rows:
        rows = [row for row in inserted_rows(bigquery) if row["kind"] == kind]
        time.sleep(0.05)
    return rows


def test_a_ready_plan_is_counted_as_indexed_and_a_failed_one_is_not(
    bigquery: Fake,
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    org, user = new_org()
    gemini[1][GEMINI_PATH] = gemini_error(403, "PERMISSION_DENIED", "The video is private.")
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(PLAN)
    retried = index_plan(client, org, user)
    # The job's user is optional; the event names who asked for the plan.
    on_app_loop(client, lambda: director().analyze(org, retried.id, None))
    [row] = events_of(bigquery, "indexed")
    assert {key: value for key, value in row.items() if key != "time"} == {
        "kind": "indexed",
        "user_id": str(user),
        "template_id": None,
        "video_id": VIDEO,
        "score": None,
        "detail": '{"model": "gemini-test", "audio": "none"}',
    }


def test_a_reviewed_take_is_counted_with_its_score_and_a_failed_one_is_not(
    bigquery: Fake,
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/take.webm": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        failed = add_take(client, org, user, f"{files.url}/gone.webm")
        on_app_loop(
            client, lambda: director().review(org, failed.id, f"{files.url}/gone.webm", user)
        )
        take = add_take(client, org, user, f"{files.url}/take.webm")
        # The job's user is optional; the event names the take's own.
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/take.webm", None))
    [row] = events_of(bigquery, "take_reviewed")
    assert {key: value for key, value in row.items() if key != "time"} == {
        "kind": "take_reviewed",
        "user_id": str(user),
        "template_id": None,
        "video_id": VIDEO,
        "score": 82,
        "detail": None,
    }


def test_a_photo_take_has_no_best_part(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/photo.jpg": ("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 64)}) as files:
        take = add_take(
            client,
            org,
            user,
            f"{files.url}/photo.jpg",
            shot=1,
            kind="photo",
            content_type="image/jpeg",
        )
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/photo.jpg", user))
    [reviewed] = takes_of(client, org, user)
    assert (reviewed.status, reviewed.bestStartMs, reviewed.bestEndMs) == ("ready", None, None)


def test_a_take_needs_a_ready_plan_a_real_shot_and_the_shot_s_kind(client: TestClient) -> None:
    org, user = new_org()
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": 0,
            "fileId": str(new_file(user)),
            "kind": "photo",
            "contentType": "image/jpeg",
            "sourceUrl": "http://storage/x",
        },
        headers=headers(org, user),
    )
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"
    _ = ready_plan(client, org, user)
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": 0,
            "fileId": str(new_file(user)),
            "kind": "photo",
            "contentType": "image/jpeg",
            "sourceUrl": "http://storage/x",
        },
        headers=headers(org, user),
    )
    assert error_of(response).code == "DIRECTOR_TAKE_KIND_MISMATCH"
    assert takes_of(client, org, user) == []


def test_a_file_added_twice_is_one_take(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    take = {
        "videoId": VIDEO,
        "shotIndex": 0,
        "fileId": str(new_file(user)),
        "kind": "video",
        "contentType": "video/mp4",
        "sourceUrl": "http://storage/clip.mp4",
    }
    first = client.post("/v1/director/takes", json=take, headers=headers(org, user))
    again = client.post("/v1/director/takes", json=take, headers=headers(org, user))
    assert (first.status_code, again.status_code) == (201, 201)
    assert first.json() == again.json()
    assert len(takes_of(client, org, user)) == 1
    # The file is that member's take: anyone else adding it finds no take of theirs.
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    theirs = client.post("/v1/director/takes", json=take, headers=headers(org, teammate))
    assert (theirs.status_code, error_of(theirs).code) == (404, "DIRECTOR_TAKE_NOT_FOUND")


def test_a_member_only_sees_their_own_takes(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    _ = add_take(client, org, user, "http://storage/take")
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    assert takes_of(client, org, teammate) == []
    assert len(takes_of(client, org, user)) == 1


def choose(
    client: TestClient, org: UUID, user: UUID, shot: int, take_id: UUID | None
) -> httpx.Response:
    return client.post(
        f"/v1/director/plans/{VIDEO}/choices",
        json={"shotIndex": shot, "takeId": None if take_id is None else str(take_id)},
        headers=headers(org, user),
    )


def test_a_member_chooses_a_take_over_director_s_pick_and_can_go_back(
    client: TestClient,
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    first = add_take(client, org, user, "http://storage/1")
    second = add_take(client, org, user, "http://storage/2")
    other_shot = add_take(
        client, org, user, "http://storage/3", shot=1, kind="photo", content_type="image/jpeg"
    )
    events = subscribe(f"realtime:org:{org}")
    assert choose(client, org, user, 0, second.id).status_code == 204
    chosen = {take.id: take.chosen for take in takes_of(client, org, user)}
    assert chosen == {first.id: False, second.id: True, other_shot.id: False}
    assert {"type": "director.changed"} in published(events)
    # One choice a shot: choosing another moves it.
    assert choose(client, org, user, 0, first.id).status_code == 204
    chosen = {take.id: take.chosen for take in takes_of(client, org, user)}
    assert chosen == {first.id: True, second.id: False, other_shot.id: False}
    # No take: back to Director's pick.
    assert choose(client, org, user, 0, None).status_code == 204
    assert not any(take.chosen for take in takes_of(client, org, user))


def test_a_member_can_only_choose_their_own_take_of_that_shot(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    take = add_take(client, org, user, "http://storage/1")
    assert error_of(choose(client, org, user, 1, take.id)).code == "DIRECTOR_TAKE_NOT_FOUND"
    assert error_of(choose(client, org, user, 0, uuid4())).code == "DIRECTOR_TAKE_NOT_FOUND"
    assert not takes_of(client, org, user)[0].chosen


def test_a_take_that_isn_t_in_storage_fails_without_a_retry(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    with serve_files({}) as files:
        take = add_take(client, org, user, f"{files.url}/gone.webm")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/gone.webm", user))
    [failed] = takes_of(client, org, user)
    assert (failed.status, failed.error) == ("failed", "DIRECTOR_REVIEW_FAILED")


def test_storage_that_can_t_be_reached_is_retried_without_naming_the_url(
    client: TestClient,
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    # Nothing listens on port 9: the connection is refused.
    take = add_take(client, org, user, "http://127.0.0.1:9/take.webm?X-Amz-Signature=secret")
    with pytest.raises(ReviewInterrupted) as interrupted:
        on_app_loop(
            client,
            lambda: director().review(
                org,
                take.id,
                "http://127.0.0.1:9/take.webm?X-Amz-Signature=secret",
                user,
                final=False,
            ),
        )
    assert "secret" not in str(interrupted.value)
    assert interrupted.value.__cause__ is None
    assert takes_of(client, org, user)[0].status == "reviewing"


@pytest.mark.parametrize(
    ("content_type", "data", "why"),
    [
        ("text/html", b"<html>", "not a take's type"),
        ("video/webm", b"\x00" * 16_000_001, "larger than an upload"),
    ],
    ids=["not a take", "too large"],
)
def test_something_that_isn_t_a_take_isn_t_reviewed(
    client: TestClient, content_type: str, data: bytes, why: str
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    with serve_files({"/x": (content_type, data)}) as files:
        take = add_take(client, org, user, f"{files.url}/x")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/x", user))
    assert takes_of(client, org, user)[0].status == "failed", why


def test_a_review_gemini_can_t_give_fails_for_a_retry(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_error(500, "INTERNAL")
    with serve_files({"/t": ("video/mp4", b"\x00\x00\x00\x18ftypmp42")}) as files:
        take = add_take(client, org, user, f"{files.url}/t", content_type="video/mp4")
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/t", user))
    assert takes_of(client, org, user)[0].error == "DIRECTOR_REVIEW_FAILED"


def test_a_review_over_its_token_cap_or_the_budget_fails_without_retrying(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW, tokens=10_000_000)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/t", user))
        assert takes_of(client, org, user)[0].error == "DIRECTOR_REVIEW_FAILED"
        # The cap's overrun used up the month: the next review isn't started.
        broke = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, broke.id, f"{files.url}/t", user))
    assert takes_of(client, org, user)[0].error == "AI_BUDGET_EXCEEDED"


def leave_in_the_month(org: UUID, tokens: int) -> None:
    """Uses the workspace's allowance (AI_MONTHLY_TOKENS_PER_ORG in the tests) up to the
    last `tokens`."""
    _ = as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', %s, 0)",
        (org, 2_000_000 - spent_this_month(org) - tokens),
    )


def spent_this_month(org: UUID) -> int:
    [(total,)] = as_org(org, "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage")
    assert isinstance(total, int)
    return total


def test_a_review_with_less_left_than_it_needs_is_a_budget_failure(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """A run is billed before its cap is checked: a review that ran over a reservation cut
    short by the month's end is the budget's failure, and one with too little left to
    start isn't started."""
    org, user = new_org()
    _ = ready_plan(client, org, user)
    leave_in_the_month(org, 50_000)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW, tokens=60_000)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/t", user))
        assert takes_of(client, org, user)[0].error == "AI_BUDGET_EXCEEDED"
        # Under a quarter of a review's cap left (the test's 120,000): Gemini isn't asked.
        asked = len(gemini[0].received)
        broke = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, broke.id, f"{files.url}/t", user))
    assert takes_of(client, org, user)[0].error == "AI_BUDGET_EXCEEDED"
    assert len(gemini[0].received) == asked


@pytest.mark.parametrize(
    ("status", "reason", "cause"),
    [(429, "RESOURCE_EXHAUSTED", "ModelHTTPError"), (503, "UNAVAILABLE", "ModelHTTPError")],
)
def test_a_rate_limited_review_is_retried_and_its_failure_says_why(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
    status: int,
    reason: str,
    cause: str,
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    activities = Activities()
    monkeypatch.setattr("app.director.log_activity", activities)
    gemini[1][GEMINI_PATH] = gemini_error(status, reason)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        url = f"{files.url}/t"
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: director().review(org, take.id, url, user, final=False))
        assert takes_of(client, org, user)[0].status == "reviewing"
        assert activities.named("director.take_reviewed") == []
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: director().review(org, take.id, url, user))
    assert takes_of(client, org, user)[0].error == "DIRECTOR_REVIEW_FAILED"
    [(failed, _)] = activities.named("director.take_reviewed")
    assert failed["target"] == {"takeId": str(take.id), "cause": cause}


def test_a_take_is_never_left_reviewing_after_its_last_attempt(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Something the review doesn't expect (the ledger unreachable as it settles): retried
    while attempts are left, and the take failed on the last."""
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)

    async def unreachable(*_args: object) -> None:
        raise ConnectionError("the database went away")

    monkeypatch.setattr("app.director.settle", unreachable)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        url = f"{files.url}/t"
        with pytest.raises(ConnectionError):
            on_app_loop(client, lambda: director().review(org, take.id, url, user, final=False))
        assert takes_of(client, org, user)[0].status == "reviewing"
        with pytest.raises(ConnectionError):
            on_app_loop(client, lambda: director().review(org, take.id, url, user))
    [failed] = takes_of(client, org, user)
    assert (failed.status, failed.error) == ("failed", "DIRECTOR_REVIEW_FAILED")


def test_a_review_for_a_take_that_s_gone_does_nothing(client: TestClient) -> None:
    org, user = new_org()
    on_app_loop(client, lambda: director().review(org, uuid4(), "http://unused", user))


# ------------------------------------------------------------------------------- the worker


class Job:
    def __init__(self, name: str, data: object) -> None:
        self.id: str | None = "job-1"
        self.name = name
        self.data = data
        self.attemptsMade = 0


class Activities:
    """The activity lines written, with the user bound on the log context when each was:
    recorded at the call, since the app's logger was configured (and cached) before any
    test could capture its output."""

    def __init__(self) -> None:
        self.lines: list[tuple[str, dict[str, object], str | None]] = []

    def __call__(self, activity: str, **fields: object) -> None:
        user = structlog.contextvars.get_contextvars().get("userId")
        self.lines.append((activity, fields, user if isinstance(user, str) else None))

    def named(self, activity: str) -> list[tuple[dict[str, object], str | None]]:
        return [(fields, user) for name, fields, user in self.lines if name == activity]


def test_the_worker_runs_both_director_jobs(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    org, user = new_org()
    plan = index_plan(client, org, user)
    from app.main import services

    passing = create_session_pass(get_settings(), services().redis)
    assert passing is not None
    process = director_processor(director(), session_pass=passing[0])
    activities = Activities()
    monkeypatch.setattr("app.director.log_activity", activities)
    monkeypatch.setattr("app.worker.log_activity", activities)
    meta = {"requestId": "req-1", "userId": str(user), "orgId": str(org)}
    job: JobLike = Job(
        "plan", {"meta": meta, "payload": {"planId": str(plan.id), "orgId": str(org)}}
    )
    on_app_loop(client, lambda: process(job))
    assert plan_of(client, org, user).status == "ready"
    # Its activity lines, for the user the job ran for: the plan written, and the job run.
    [(indexed, _)] = activities.named("director.indexed")
    assert indexed["user_id"] == user
    assert indexed["target"] == {
        "planId": str(plan.id),
        "videoId": plan.videoId,
        "model": "gemini-test",
        "audio": "none",
        "inputTokens": 900,
        "outputTokens": 100,
    }
    [(finished, bound)] = activities.named("job.finished")
    assert finished["target"] == {
        "queue": "ai-director",
        "job": "plan",
        "jobId": "job-1",
        "attempt": 1,
    }
    assert bound == str(user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        review: JobLike = Job(
            "review-take",
            {
                "meta": {"orgId": str(org)},
                "payload": {
                    "takeId": str(take.id),
                    "orgId": str(org),
                    "sourceUrl": f"{files.url}/t",
                },
            },
        )
        on_app_loop(client, lambda: process(review))
    assert takes_of(client, org, user)[0].status == "ready"
    # A review queued by the previous release, on `ai-director`, is still run.
    assert activities.named("job.finished")[-1][0]["target"] == {
        "queue": "ai-director",
        "job": "review-take",
        "jobId": "job-1",
        "attempt": 1,
    }
    # A job without a user still names whose take it reviewed, and the score.
    [(reviewed, _)] = activities.named("director.take_reviewed")
    assert reviewed["user_id"] == user
    assert reviewed["target"] == {
        "takeId": str(take.id),
        "videoId": plan.videoId,
        "shotIndex": 0,
        "kind": "video",
        "score": REVIEW["score"],
        "inputTokens": 900,
        "outputTokens": 100,
    }
    # A post-session pass: with no recording backend yet, it goes through nothing.
    session_id = uuid4()
    session: JobLike = Job(
        "session-pass",
        {"meta": {"orgId": str(org)}, "payload": {"sessionId": str(session_id), "orgId": str(org)}},
    )
    on_app_loop(client, lambda: process(session))
    assert activities.named("job.finished")[-1][0]["target"] == {
        "queue": "ai-director",
        "job": "session-pass",
        "jobId": "job-1",
        "attempt": 1,
    }
    with pytest.raises(ValidationError):
        on_app_loop(client, lambda: process(Job("unknown", {})))


def test_the_worker_runs_reviews_from_their_own_queue(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    activities = Activities()
    monkeypatch.setattr("app.worker.log_activity", activities)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    process = review_processor(director())
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        review = Job(
            "review-take",
            {
                "meta": {"orgId": str(org)},
                "payload": {
                    "takeId": str(take.id),
                    "orgId": str(org),
                    "sourceUrl": f"{files.url}/t",
                },
            },
        )
        on_app_loop(client, lambda: process(review))
    assert takes_of(client, org, user)[0].status == "ready"
    [(finished, _)] = activities.named("job.finished")
    assert finished["target"] == {
        "queue": "ai-review",
        "job": "review-take",
        "jobId": "job-1",
        "attempt": 1,
    }
    # Its last attempt is the queue's sixth: a failure before then is retried.
    gemini[1][GEMINI_PATH] = gemini_error(429, "RESOURCE_EXHAUSTED")
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        again = add_take(client, org, user, f"{files.url}/t")
        retried = Job(
            "review-take",
            {
                "meta": {"orgId": str(org)},
                "payload": {
                    "takeId": str(again.id),
                    "orgId": str(org),
                    "sourceUrl": f"{files.url}/t",
                },
            },
        )
        retried.attemptsMade = 4
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: process(retried))
        assert takes_of(client, org, user)[0].status == "reviewing"
        retried.attemptsMade = 5
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: process(retried))
    assert takes_of(client, org, user)[0].status == "failed"
    with pytest.raises(ValidationError):
        on_app_loop(client, lambda: process(Job("plan", {})))


def test_the_worker_process_plans_and_reviews_what_s_queued(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    extra_env: dict[str, str],
) -> None:
    org, user = new_org()
    plan = index_plan(client, org, user)
    worker = subprocess.Popen(
        [sys.executable, "-m", "app.worker"], env={**os.environ, **ENV, **extra_env}
    )
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and plan.status != "ready":
            time.sleep(0.2)
            plan = plan_of(client, org, user)
        assert plan.status == "ready"
        # A take's review, from the reviews' own queue.
        gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
        with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
            take = add_take(client, org, user, f"{files.url}/t")
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and take.status != "ready":
                time.sleep(0.2)
                take = takes_of(client, org, user)[0]
        assert take.status == "ready"
    finally:
        worker.terminate()
        assert worker.wait(timeout=10) == 0
