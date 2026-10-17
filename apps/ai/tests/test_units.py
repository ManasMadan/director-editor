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

from app.auth import verify
from app.director import create_director_model, create_index_model, youtube_video
from app.errors import AppError
from app.settings import Settings
from tests.tokens import SECRET, service_token

USER, ORG = uuid4(), uuid4()


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
    from app.main import services

    with pytest.raises(RuntimeError, match="lifespan"):
        services()


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
