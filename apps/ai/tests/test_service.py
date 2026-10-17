"""The service against real Postgres and Redis (`bun run test:integration`): health,
authentication, request validation, errors and the worker process. Director itself is
tested in tests/test_director.py.

Uses the database in AI_DATABASE_URL (migrated), with fresh organizations per test,
and its own Redis database; fixtures are written as the migrator.
"""

import os
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from app.heartbeat import HEARTBEAT, alive
from app.settings import get_settings
from tests.fakes import otlp_collector, serve
from tests.support import ENV, body, error_of, headers, new_org

pytestmark = pytest.mark.integration


@pytest.fixture
def extra_env() -> dict[str, str]:
    # Director on, so its routes get as far as validating requests; nothing here reaches
    # Gemini.
    return {"DIRECTOR_MODEL": "gemini-test", "GOOGLE_API_KEY": "test-key"}


def test_health(client: TestClient) -> None:
    assert body(client.get("/health/live")) == {"status": "ok"}
    assert body(client.get("/health/ready")) == {"status": "ok"}
    assert body(client.get("/health/dependencies")) == {"status": "ok"}


def test_every_route_needs_the_api_s_token(client: TestClient) -> None:
    for method, path in [
        ("post", "/v1/director/plans"),
        ("get", "/v1/director/plans/dQw4w9WgXcQ"),
        ("post", "/v1/director/scene-checks"),
        ("post", "/v1/director/takes"),
        ("get", "/v1/director/plans/dQw4w9WgXcQ/takes"),
    ]:
        response = client.request(method, path, headers={"x-request-id": "r1"})
        assert response.status_code == 401
        assert body(response) == {
            "defined": True,
            "code": "UNAUTHENTICATED",
            "status": 401,
            "message": "UNAUTHENTICATED",
            "data": {"params": {}, "requestId": "r1"},
        }


def test_invalid_input_is_a_validation_error(client: TestClient) -> None:
    org, user = new_org()
    response = client.post(
        "/v1/director/scene-checks", json={"videoId": ""}, headers=headers(org, user)
    )
    assert response.status_code == 422
    error = error_of(response)
    assert error.code == "VALIDATION_FAILED"
    # Where the contract's errorData has them, not among the message params.
    assert error.data.params == {}
    assert {tuple(issue.path) for issue in error.data.issues or []} == {
        ("videoId",),
        ("shotIndex",),
        ("image",),
    }


def test_requests_are_strict(client: TestClient) -> None:
    org, user = new_org()
    for path, request in [
        ("/v1/director/plans", {"videoId": "dQw4w9WgXcQ", "force": True}),
        ("/v1/director/plans", {"videoId": 5}),
        ("/v1/director/scene-checks", {"videoId": "dQw4w9WgXcQ", "shotIndex": "0", "image": "x"}),
    ]:
        response = client.post(path, json=request, headers=headers(org, user))
        assert response.status_code == 422, request
        assert error_of(response).code == "VALIDATION_FAILED"


def test_an_unknown_route_is_a_contract_error(client: TestClient) -> None:
    response = client.get("/v1/nope")
    assert response.status_code == 404
    assert body(response) == {
        "defined": True,
        "code": "NOT_FOUND",
        "status": 404,
        "message": "NOT_FOUND",
        "data": {"params": {}},
    }


def test_director_is_off_without_its_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    org, user = new_org()
    monkeypatch.delenv("DIRECTOR_MODEL")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as without:
        response = without.post(
            "/v1/director/plans", json={"videoId": "dQw4w9WgXcQ"}, headers=headers(org, user)
        )
    error = error_of(response)
    assert (response.status_code, error.code, error.data.params) == (
        404,
        "FEATURE_DISABLED",
        {"feature": "director"},
    )


def test_the_worker_runs_and_stops_cleanly_without_director_s_model(client: TestClient) -> None:
    assert client is not None
    # Whatever an earlier worker left: this one must prove itself.
    HEARTBEAT.unlink(missing_ok=True)
    with serve({"/v1/traces": otlp_collector, "/v1/metrics": otlp_collector}) as collector:
        # With a collector configured, as in production: it starts its exporters and still
        # runs and stops cleanly. (An idle worker records nothing, so nothing is sent.)
        env = {**os.environ, **ENV, "OTEL_EXPORTER_OTLP_ENDPOINT": collector.url}
        worker = subprocess.Popen([sys.executable, "-m", "app.worker"], env=env)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not alive():
                time.sleep(0.2)
            # Its liveness probe passes once its loop runs.
            assert alive()
        finally:
            worker.terminate()
            assert worker.wait(timeout=10) == 0
