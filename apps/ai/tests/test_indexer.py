"""The Cloud Run indexer (app/indexer.py): who may call it, what it answers, and how it
reaches Vertex AI with its own service account. Against a local Gemini API, metadata
server and certificate endpoint that speak the real protocols (tests/fakes.py)."""

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from app.indexing import RemoteIndexer
from app.schemas import IndexRequest, IndexResult
from app.settings import get_indexer_settings
from tests.fakes import (
    ACCESS_TOKEN,
    CERTS_PATH,
    GEMINI_MODEL,
    GEMINI_PATH,
    Fake,
    Identity,
    Reply,
    gemini_error,
    gemini_output,
    serve,
    serve_identity,
)
from tests.support import body, error_of
from tests.test_director import PLAN, VIDEO

# The commit the indexer's image was built from, and the worker's too.
RELEASE = "sha-test"


class _NoFallback:
    """The worker's own indexing, which a test whose indexer runs the worker's release
    never needs."""

    async def index(self, request: IndexRequest, *, watched: Callable[[], object]) -> IndexResult:
        raise AssertionError(f"indexed {request.planId} here, not on the indexer")


pytestmark = pytest.mark.integration

AUDIENCE = "https://director-indexer.test"
VERTEX_PATH = (
    "/v1beta1/projects/test-project/locations/global/publishers/google/models/"
    f"{GEMINI_MODEL}:generateContent"
)


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    handlers: dict[str, Callable[[bytes], Reply]] = {GEMINI_PATH: gemini_output(PLAN)}
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def identity() -> Iterator[Identity]:
    with serve_identity() as found:
        yield found


def _env(gemini: Fake, identity: Identity, audience: str) -> dict[str, str]:
    """The indexer's environment, on the Gemini API (a key) unless a test says otherwise."""
    return {
        "NODE_ENV": "test",
        "INDEXER_URL": audience,
        "INDEXER_INVOKER": identity.service_account,
        "GOOGLE_CERTS_URL": f"{identity.url}{CERTS_PATH}",
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini.url,
        "GOOGLE_VERTEX": "false",
        "MEDIA_BUCKET": "",
        "RELEASE": RELEASE,
    }


@pytest.fixture
def indexer(
    monkeypatch: pytest.MonkeyPatch,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    identity: Identity,
) -> Iterator[TestClient]:
    for key, value in _env(gemini[0], identity, AUDIENCE).items():
        monkeypatch.setenv(key, value)
    get_indexer_settings.cache_clear()
    from app.indexer import app

    with TestClient(app) as test_client:
        yield test_client
    get_indexer_settings.cache_clear()


def _request(max_tokens: int = 200_000) -> dict[str, object]:
    return {
        "videoId": VIDEO,
        "orgId": str(uuid4()),
        "planId": str(uuid4()),
        "maxTokens": max_tokens,
    }


def _index(
    client: TestClient, identity: Identity, request: dict[str, object] | None = None
) -> httpx2.Response:
    return client.post(
        "/v1/index",
        json=request or _request(),
        headers={"authorization": f"Bearer {identity.token(AUDIENCE)}"},
    )


def test_the_indexer_is_alive(indexer: TestClient) -> None:
    response = indexer.get("/health/live")
    assert (response.status_code, body(response)) == (200, {"status": "ok"})


def test_the_indexer_publishes_no_api_docs(indexer: TestClient) -> None:
    for path in ("/openapi.json", "/docs", "/redoc"):
        response = indexer.get(path)
        assert (response.status_code, error_of(response).code) == (404, "NOT_FOUND"), path


def test_the_indexer_writes_the_plan_for_the_account_that_may_call_it(
    indexer: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    response = _index(indexer, identity)
    assert response.status_code == 200, response.text
    result = IndexResult.model_validate_json(response.content)
    assert (result.model, result.plan.title, len(result.plan.shots)) == (
        GEMINI_MODEL,
        "Get ready with me",
        2,
    )
    # No MEDIA_BUCKET: the audio isn't captured, and the plan doesn't wait for it.
    assert (result.audio.status, result.audio.objectKey) == ("none", None)
    assert (result.usage.inputTokens, result.usage.outputTokens) == (900, 100)
    # Which release wrote it, for the worker to tell an indexer left on an older one.
    assert result.release == RELEASE
    [(path, sent)] = gemini[0].received
    assert path == GEMINI_PATH
    assert b'"file_uri": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"' in sent


def test_only_the_expected_account_may_call_the_indexer(
    indexer: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    def call(authorization: str | None) -> tuple[int, str]:
        headers = {"authorization": authorization} if authorization else {}
        response = indexer.post("/v1/index", json=_request(), headers=headers)
        return response.status_code, error_of(response).code

    assert call(None) == (401, "UNAUTHENTICATED")
    assert call(f"Basic {identity.token(AUDIENCE)}") == (401, "UNAUTHENTICATED")
    assert call(f"Bearer {identity.token('https://elsewhere.test')}") == (401, "UNAUTHENTICATED")
    someone = identity.token(AUDIENCE, email="someone@test-project.iam.gserviceaccount.com")
    assert call(f"Bearer {someone}") == (403, "FORBIDDEN")
    assert gemini[0].received == []


def test_requests_are_strict(indexer: TestClient, identity: Identity) -> None:
    response = _index(indexer, identity, {**_request(), "extra": True})
    assert (response.status_code, error_of(response).code) == (422, "VALIDATION_FAILED")


def test_a_short_gemini_may_not_watch_is_answered_with_its_reason(
    indexer: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(403, "PERMISSION_DENIED", "The video is private.")
    response = _index(indexer, identity)
    error = error_of(response)
    assert (response.status_code, error.code) == (422, "DIRECTOR_VIDEO_UNAVAILABLE")
    # What the run used goes back too, for the worker to count against the budget.
    assert error.data.params == {"inputTokens": 0, "outputTokens": 0}


def test_a_short_past_its_token_cap_is_answered_with_what_it_used(
    indexer: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    gemini[1][GEMINI_PATH] = gemini_output(PLAN, tokens=10_000_000)
    response = _index(indexer, identity, _request(max_tokens=10_000))
    error = error_of(response)
    assert (response.status_code, error.code) == (422, "DIRECTOR_ANALYSIS_FAILED")
    assert error.data.params == {"inputTokens": 9_999_900, "outputTokens": 100}


def test_an_outage_is_answered_for_the_worker_to_retry(
    indexer: TestClient,
    identity: Identity,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    response = _index(indexer, identity)
    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")


# ------------------------------------------------------------------ as Cloud Run runs it


_ADDRESS = TypeAdapter(tuple[str, int])


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return _ADDRESS.validate_python(probe.getsockname())[1]


def _answers(url: str) -> bool:
    try:
        return httpx.get(f"{url}/health/live").status_code == 200
    except httpx.TransportError:
        return False


@contextmanager
def _running_indexer(env: dict[str, str]) -> Generator[str]:
    """The indexer as Cloud Run starts it (`uvicorn app.indexer:app`), in its own process
    (uvicorn reads the port from UVICORN_PORT as well as --port)."""
    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.indexer:app", "--host", "127.0.0.1"],
        env={**env, "INDEXER_URL": url, "UVICORN_PORT": str(port)},
        cwd=Path(__file__).resolve().parents[1],
    )
    try:
        deadline = time.monotonic() + 20
        while not _answers(url):
            assert process.poll() is None, "the indexer exited before it answered"
            assert time.monotonic() < deadline, "the indexer never answered"
            time.sleep(0.1)
        yield url
    finally:
        process.terminate()
        # A clean shutdown: uvicorn finishes serving, then exits on the signal it got.
        assert process.wait(timeout=10) == -signal.SIGTERM


async def test_on_cloud_run_the_indexer_reaches_vertex_with_its_own_service_account(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    identity: Identity,
) -> None:
    """No API key: Vertex AI through Application Default Credentials, which on Cloud Run
    are the service's account, from the metadata server. The worker's side is the real
    one too: an ID token from its own metadata server, for the indexer's URL."""
    gemini[1][VERTEX_PATH] = gemini_output(PLAN)
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in {"GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"}
    }
    env = {
        **environment,
        **_env(gemini[0], identity, ""),
        "GOOGLE_API_KEY": "",
        "GOOGLE_VERTEX": "true",
        "GOOGLE_CLOUD_PROJECT": "test-project",
        "VERTEX_LOCATION": "global",
        # google-auth finds Application Default Credentials on the metadata server only
        # when nothing else provides them: no gcloud login from this machine.
        "CLOUDSDK_CONFIG": str(tmp_path),
        "GCE_METADATA_HOST": identity.host,
        "GCE_METADATA_IP": identity.host,
    }
    monkeypatch.setenv("GCE_METADATA_HOST", identity.host)
    with _running_indexer(env) as url:
        async with httpx.AsyncClient() as http:
            result = await RemoteIndexer(url, http, release=RELEASE, fallback=_NoFallback()).index(
                IndexRequest.model_validate(_request()), watched=_nothing
            )
    assert result.model == GEMINI_MODEL
    assert [path for path, _ in gemini[0].received] == [VERTEX_PATH]
    assert gemini[0].authorizations == [f"Bearer {ACCESS_TOKEN}"]


async def _nothing() -> None:
    return None
