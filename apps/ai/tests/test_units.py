"""Pure tests: no database, Redis or model provider."""

import os
import runpy
import secrets
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from pydantic import ValidationError
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.test import TestModel
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import RunUsage, UsageLimits

from app.auth import verify
from app.director import create_director_model, create_index_model, create_planner_agent
from app.errors import AppError
from app.indexing import index_short, youtube_video
from app.schemas import MAX_PLAN_TOKENS, IndexRequest, ShotPlanDraft
from app.settings import IndexerSettings, Settings
from tests.tokens import SECRET, service_token

USER, ORG = uuid4(), uuid4()

PLAN_DRAFT: dict[str, object] = {
    "title": "A plan",
    "format": "GRWM",
    "summary": "A summary.",
    "audio": "none",
    "durationSeconds": 4,
    "shots": [
        {
            "kind": "video",
            "title": "A shot",
            "purpose": "Shows something.",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 4,
            "durationSeconds": 4,
            "camera": "back",
            "scene": "Anywhere with light",
            "sceneLandmark": None,
            "framing": {
                "shotSize": "full-body",
                "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
                "note": "Head to toe, centered.",
            },
            "phoneAngle": {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"},
            "pose": {"description": "Standing, arms relaxed.", "keypoints": []},
            "steps": [{"atSeconds": 0, "instruction": "Do it.", "cameraMove": "static"}],
            "script": [],
        }
    ],
}


class CountingTestModel(TestModel):
    """pydantic-ai's offline model, answering with its output arguments, that counts the
    runs it answers."""

    runs = 0

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        self.runs += 1
        return await super().request(messages, model_settings, model_request_parameters)


def test_a_valid_token_names_the_user_and_organization() -> None:
    caller = verify(service_token(USER, ORG), SECRET)
    assert (caller.user_id, caller.org_id) == (USER, ORG)


@pytest.mark.parametrize(
    "token",
    [
        service_token(USER, ORG, secret=secrets.token_urlsafe(32)),  # someone else's
        service_token(USER, ORG, lifetime=-10),  # expired
        service_token(USER, ORG, aud="web"),
        service_token(USER, ORG, iss="someone"),
        service_token(USER, ORG, org=None),
        service_token(USER, ORG, lifetime=3_600),  # lives too long to be one call's
        service_token(USER, ORG, org="not-a-uuid"),
        "not.a.jwt",
    ],
)
def test_bad_tokens_are_refused(token: str) -> None:
    with pytest.raises(AppError) as error:
        verify(token, SECRET)
    assert (error.value.code, error.value.status) == ("UNAUTHENTICATED", 401)


def _settings(**env: str) -> Settings:
    """Settings from exactly these values: the process environment (a loaded .env when
    tests run alongside the integration suite) must not leak in."""
    base = {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": SECRET,
    }
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate({**base, **env})


def test_a_short_service_secret_is_refused() -> None:
    with pytest.raises(ValidationError):
        _settings(AI_SERVICE_SECRET="x" * 31)  # one character short


def test_production_refuses_a_plain_http_gemini_endpoint() -> None:
    base = {"NODE_ENV": "production"}
    assert _settings(**base).google_base_url is None
    assert _settings(**base, GOOGLE_BASE_URL="https://gateway.example.com").google_base_url
    with pytest.raises(ValidationError, match="GOOGLE_BASE_URL must be HTTPS"):
        _settings(**base, GOOGLE_BASE_URL="http://localhost:12112")


def test_director_needs_its_gemini_key() -> None:
    assert _settings(DIRECTOR_MODEL="gemini-3.5-flash", GOOGLE_API_KEY="key").director_model
    with pytest.raises(ValidationError, match="DIRECTOR_MODEL needs GOOGLE_API_KEY"):
        _settings(DIRECTOR_MODEL="gemini-3.5-flash")


def test_director_calls_vertex_ai_when_asked() -> None:
    director = {"DIRECTOR_MODEL": "gemini-3.5-flash", "GOOGLE_API_KEY": "key"}
    gemini_api = create_director_model(_settings(**director))
    vertex = create_director_model(
        _settings(**director, GOOGLE_VERTEX="true", GOOGLE_CLOUD_PROJECT="p")
    )
    assert gemini_api is not None
    assert gemini_api.system == "google"
    assert gemini_api.model_name == "gemini-3.5-flash"
    assert vertex is not None
    assert vertex.system == "google-cloud"
    # An API key drops the project/location from the request unless the model is
    # addressed by its full resource name, which is the only way to reach a location
    # other than us-central1 (task 2.1.1b-brief.md's "Why").
    assert (
        vertex.model_name == "projects/p/locations/global/publishers/google/models/gemini-3.5-flash"
    )


def test_vertex_needs_the_cloud_project_once_a_key_is_set() -> None:
    # .env.example ships GOOGLE_VERTEX=true with no key yet, so that must still boot.
    assert _settings(GOOGLE_VERTEX="true").google_cloud_project is None
    assert _settings(GOOGLE_VERTEX="true", GOOGLE_CLOUD_PROJECT="p").google_cloud_project == "p"
    with pytest.raises(ValidationError, match="GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT"):
        _settings(GOOGLE_VERTEX="true", GOOGLE_API_KEY="key")


def test_the_index_model_addresses_vertex_at_its_configured_location() -> None:
    settings = _settings(
        GOOGLE_VERTEX="true",
        GOOGLE_CLOUD_PROJECT="p",
        GOOGLE_API_KEY="key",
        VERTEX_LOCATION="us-east5",
    )
    model = create_index_model(settings, "gemini-4-argon")
    assert (
        model.model_name == "projects/p/locations/us-east5/publishers/google/models/gemini-4-argon"
    )
    # The Gemini API (no Vertex): the bare name, as before.
    gemini_api = create_index_model(_settings(GOOGLE_API_KEY="key"), "gemini-4-argon")
    assert gemini_api.model_name == "gemini-4-argon"


def test_vertex_without_a_project_is_a_configuration_bug() -> None:
    """Settings refuses GOOGLE_VERTEX=true without GOOGLE_CLOUD_PROJECT at boot
    (test_vertex_needs_the_cloud_project); only a Settings built another way, bypassing
    that validator, could reach the model factory with it unset."""
    bypassed = Settings.model_construct(
        google_vertex=True, google_cloud_project=None, vertex_location="global"
    )
    with pytest.raises(RuntimeError, match="GOOGLE_CLOUD_PROJECT"):
        create_index_model(bypassed, "gemini-4-argon")


def _indexer_settings(**env: str) -> IndexerSettings:
    """The Cloud Run indexer's settings from exactly these values (see `_settings`)."""
    base = {
        "INDEXER_URL": "https://director-indexer-1.us-central1.run.app",
        "INDEXER_INVOKER": "director-vm@p.iam.gserviceaccount.com",
    }
    with patch.dict(os.environ, {}, clear=True):
        return IndexerSettings.model_validate({**base, **env})


def test_on_vertex_without_a_key_the_model_uses_the_service_account() -> None:
    """Cloud Run's indexer has no express key: Vertex AI through Application Default
    Credentials (its service account), for the project and location the settings name,
    and the model still addressed by its full resource name."""
    settings = _indexer_settings(GOOGLE_VERTEX="true", GOOGLE_CLOUD_PROJECT="p")
    assert settings.google_api_key is None
    model = create_index_model(settings, "gemini-4-argon")
    assert model.system == "google-cloud"
    assert model.client.vertexai is True
    assert model.model_name == "projects/p/locations/global/publishers/google/models/gemini-4-argon"


def test_the_indexer_needs_its_audience_its_caller_and_a_way_to_gemini() -> None:
    assert _indexer_settings(GOOGLE_API_KEY="key").google_vertex is False
    with pytest.raises(ValidationError, match="INDEXER_URL"):
        _indexer_settings(GOOGLE_API_KEY="key", INDEXER_URL="")
    with pytest.raises(ValidationError, match="INDEXER_INVOKER"):
        _indexer_settings(GOOGLE_API_KEY="key", INDEXER_INVOKER="not an email")
    with pytest.raises(ValidationError, match="GOOGLE_VERTEX=true needs GOOGLE_CLOUD_PROJECT"):
        _indexer_settings(GOOGLE_VERTEX="true")
    with pytest.raises(ValidationError, match="needs GOOGLE_API_KEY or GOOGLE_VERTEX=true"):
        _indexer_settings()


def test_production_refuses_plain_http_for_the_indexer_and_google_s_certificates() -> None:
    production = {"NODE_ENV": "production", "GOOGLE_API_KEY": "key"}
    assert _indexer_settings(**production).google_certs_url.host == "www.googleapis.com"
    with pytest.raises(ValidationError, match="INDEXER_URL must be HTTPS"):
        _indexer_settings(**production, INDEXER_URL="http://indexer.test")
    with pytest.raises(ValidationError, match="GOOGLE_CERTS_URL must be HTTPS"):
        _indexer_settings(**production, GOOGLE_CERTS_URL="http://127.0.0.1:1/certs")
    with pytest.raises(ValidationError, match="INDEXER_URL must be HTTPS"):
        _settings(NODE_ENV="production", INDEXER_URL="http://indexer.test")


def test_the_media_bucket_is_a_bucket_name() -> None:
    assert _settings(MEDIA_BUCKET="director-media-1053522546520").media_bucket
    for wrong in ("gs://director-media", "Director_Media", "a", "-starts-with-a-dash"):
        with pytest.raises(ValidationError, match="MEDIA_BUCKET"):
            _settings(MEDIA_BUCKET=wrong)


def test_a_plan_s_token_cap_has_a_ceiling() -> None:
    """The indexer runs whatever cap the worker sends: bounded like the setting it comes
    from, so a bad request can't ask for an unbounded run."""
    request = {"videoId": "dQw4w9WgXcQ", "orgId": str(ORG), "planId": str(USER)}
    assert IndexRequest.model_validate({**request, "maxTokens": MAX_PLAN_TOKENS})
    with pytest.raises(ValidationError, match="maxTokens"):
        IndexRequest.model_validate({**request, "maxTokens": MAX_PLAN_TOKENS + 1})
    assert _settings(DIRECTOR_TOKENS_PER_PLAN=str(MAX_PLAN_TOKENS)).director_tokens_per_plan
    with pytest.raises(ValidationError, match="DIRECTOR_TOKENS_PER_PLAN"):
        _settings(DIRECTOR_TOKENS_PER_PLAN=str(MAX_PLAN_TOKENS + 1))


def test_the_indexer_url_is_an_origin() -> None:
    """The ID token's audience is this URL exactly, and Cloud Run's is the service's URL
    with no path or trailing slash."""
    url = "https://director-indexer-1053522546520.us-central1.run.app"
    assert _settings(INDEXER_URL=url).indexer_url == url
    for wrong in (f"{url}/", f"{url}/v1/index", "director-indexer.run.app"):
        with pytest.raises(ValidationError, match="INDEXER_URL"):
            _settings(INDEXER_URL=wrong)


def test_youtube_videos_go_without_a_container_type() -> None:
    video = youtube_video("jNQXAC9IVRw")
    assert video.url == "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    assert video.is_youtube
    assert video.media_type == "video/*"


async def test_nothing_reaches_the_database_before_the_engine_is_opened() -> None:
    from app.db.session import close_engine, engine, tenant

    await close_engine()
    with pytest.raises(RuntimeError, match="open_engine"):
        engine()
    with pytest.raises(RuntimeError, match="open_engine"):
        async with tenant(ORG):
            pass


def test_routes_have_no_services_before_the_app_starts() -> None:
    from app.indexer import services as indexer_services
    from app.main import services

    with pytest.raises(RuntimeError, match="lifespan"):
        services()
    with pytest.raises(RuntimeError, match="lifespan"):
        indexer_services()


def test_the_openapi_export_is_the_committed_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "openapi.json"
    monkeypatch.setattr(sys, "argv", ["export_openapi", str(out)])
    runpy.run_module("app.export_openapi", run_name="__main__")
    # What `bun run gen` writes; CI also fails when the committed copy is stale.
    committed = Path(__file__).resolve().parents[1] / "openapi.json"
    assert out.read_text() == committed.read_text()


def test_a_job_this_version_does_not_know_fails() -> None:
    from app.worker import DIRECTOR_JOB_NAME

    assert DIRECTOR_JOB_NAME.validate_python("plan") == "plan"
    with pytest.raises(ValidationError):
        DIRECTOR_JOB_NAME.validate_python("translate")


def test_the_worker_heartbeat_is_alive_while_fresh_and_dead_when_stale(tmp_path: Path) -> None:
    from app.heartbeat import alive

    path = tmp_path / "alive"
    assert not alive(path)
    path.touch()
    mtime = path.stat().st_mtime
    assert alive(path, 60, now=lambda: mtime + 59)
    assert not alive(path, 60, now=lambda: mtime + 61)


async def test_the_worker_heartbeat_touches_its_file_until_cancelled(tmp_path: Path) -> None:
    import asyncio

    from app.heartbeat import beat

    path = tmp_path / "alive"
    task = asyncio.create_task(beat(path, every=0.01))
    await asyncio.sleep(0.05)
    assert path.exists()
    _ = task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_the_liveness_probe_passes_only_with_a_fresh_heartbeat(tmp_path: Path) -> None:
    # The probe's own command, reading the heartbeat from the temporary directory.
    def probe() -> int:
        env = {**os.environ, "TMPDIR": str(tmp_path)}
        return subprocess.run(
            [sys.executable, "-m", "app.heartbeat"], env=env, check=False
        ).returncode

    assert probe() == 1
    (tmp_path / "ai-worker-alive").touch()
    assert probe() == 0


def test_a_best_part_under_a_millisecond_is_no_part() -> None:
    from app.director import best_range
    from app.schemas import TakeReview

    def review(start: float, end: float) -> TakeReview:
        return TakeReview(bestStartSeconds=start, bestEndSeconds=end, score=50, feedback="Fine.")

    assert best_range(review(1.0002, 1.0004), "video") == (None, None)
    assert best_range(review(1.0, 2.5), "video") == (1000, 2500)
    assert best_range(review(1.0, 2.5), "photo") == (None, None)


def test_the_service_boots_from_the_example_with_its_empty_values() -> None:
    """`bun --env-file` hands an empty `KEY=` over as an empty string: that means unset."""
    from dotenv import dotenv_values

    from app.settings import get_settings
    from tests import ENV_EXAMPLE

    raw = {key: value or "" for key, value in dotenv_values(ENV_EXAMPLE).items()}
    raw |= {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "AI_SERVICE_SECRET": SECRET,
        "GOOGLE_BASE_URL": "",
    }
    get_settings.cache_clear()
    try:
        with patch.dict(os.environ, raw, clear=True):
            settings = get_settings()
        assert settings.google_base_url is None
    finally:
        get_settings.cache_clear()


async def test_a_drafted_callback_that_raises_is_not_retried_as_the_planner_failing() -> None:
    """`drafted` runs once the planner has answered, outside the retry: an error from it
    (even one that looks like an outage) is the caller's own, and doesn't send the same
    video to Gemini again or on to the fallback model."""
    planner = CountingTestModel(custom_output_args=PLAN_DRAFT)
    fallback = CountingTestModel(custom_output_args=PLAN_DRAFT)
    calls: list[ShotPlanDraft] = []

    def drafted(draft: ShotPlanDraft) -> None:
        calls.append(draft)
        raise TimeoutError("the caller's own bookkeeping timed out")

    with patch("app.indexing.PLANNER_RETRY_BACKOFF_SECONDS", 0), pytest.raises(TimeoutError):
        await index_short(
            create_planner_agent(planner),
            "planner",
            create_planner_agent(fallback),
            "fallback",
            "22k0fZarxh8",
            RunUsage(),
            UsageLimits(),
            drafted=drafted,
        )
    assert (len(calls), planner.runs, fallback.runs) == (1, 1, 0)
