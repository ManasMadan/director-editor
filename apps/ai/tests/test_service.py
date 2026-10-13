"""The service against real Postgres and Redis (`bun run test:integration`):
routes, tenancy, indexing, retrieval, the assistant's stream, budgets and the worker.

Uses the database in AI_DATABASE_URL (migrated), with fresh organizations per test,
and its own Redis database; fixtures are written as the migrator.
"""

import os
import subprocess
import sys
import time
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.assistant import AssistantEvent, DoneEvent, SourcesEvent, TextEvent
from app.contracts.ai_ingest_ingest_job import AiIngestIngestJob
from app.heartbeat import alive
from app.settings import get_settings
from tests.fakes import otlp_collector, serve
from tests.support import (
    ENV,
    as_org,
    body,
    document_of,
    documents_of,
    error_of,
    headers,
    index_all,
    new_org,
    on_app_loop,
    published,
    stored_job,
    subscribe,
)

pytestmark = pytest.mark.integration


def test_health(client: TestClient) -> None:
    assert body(client.get("/health/live")) == {"status": "ok"}
    assert body(client.get("/health/ready")) == {"status": "ok"}
    assert body(client.get("/health/dependencies")) == {"status": "ok"}


def test_every_route_needs_the_api_s_token(client: TestClient) -> None:
    for method, path in [
        ("get", "/v1/documents"),
        ("post", "/v1/documents"),
        ("post", "/v1/assistant/answers"),
        ("post", "/v1/sentiment"),
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


def test_the_sentiment_route(client: TestClient) -> None:
    org, user = new_org()
    response = client.post(
        "/v1/sentiment", json={"text": "I love this, it is great"}, headers=headers(org, user)
    )
    assert body(response) == {"label": "positive", "score": 1.0, "model": "wordlist-v1"}


def test_invalid_input_is_a_validation_error(client: TestClient) -> None:
    org, user = new_org()
    response = client.post("/v1/documents", json={"title": ""}, headers=headers(org, user))
    assert response.status_code == 422
    error = error_of(response)
    assert error.code == "VALIDATION_FAILED"
    # Where the contract's errorData has them, not among the message params.
    assert error.data.params == {}
    assert {tuple(issue.path) for issue in error.data.issues or []} == {("title",), ("content",)}


def test_requests_are_strict(client: TestClient) -> None:
    org, user = new_org()
    for path, request in [
        ("/v1/documents", {"title": "T", "content": "C", "tags": ["x"]}),
        ("/v1/documents", {"title": 5, "content": "C"}),
        ("/v1/sentiment", {"text": "fine", "lang": "en"}),
        ("/v1/assistant/answers", {"question": "Why?", "stream": False}),
    ]:
        response = client.post(path, json=request, headers=headers(org, user))
        assert response.status_code == 422, request
        assert error_of(response).code == "VALIDATION_FAILED"


def test_adding_a_document_queues_it_and_indexing_makes_it_searchable(client: TestClient) -> None:
    org, user = new_org()
    events = subscribe(f"realtime:org:{org}")
    created = client.post(
        "/v1/documents",
        json={
            "title": "Handbook",
            "content": "Refunds take five days.\n\nThe office is in Lisbon.",
        },
        headers=headers(org, user),
    )
    assert created.status_code == 201
    document = document_of(created)
    assert document.status == "pending"

    # Queued once, under the shared queue's prefix, with the document id as the job id.
    job = stored_job(f"{{ai-ingest}}:ai-ingest:{document.id}")
    payload = AiIngestIngestJob.model_validate_json(job[b"data"]).payload
    assert (payload.documentId, payload.orgId) == (document.id, org)

    index_all(client, org)
    [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    assert (listed.status, listed.chunkCount) == ("ready", 1)

    # Screens showing the documents were told, when it was added and when it was ready.
    assert published(events) == [{"type": "documents.changed"}] * 2


def test_each_workspace_sees_only_its_documents(client: TestClient) -> None:
    org, user = new_org()
    other_org, other_user = new_org()
    doc = document_of(
        client.post(
            "/v1/documents",
            json={"title": "Private", "content": "Secret plans."},
            headers=headers(org, user),
        )
    )
    assert documents_of(client.get("/v1/documents", headers=headers(other_org, other_user))) == []
    deleted = client.delete(f"/v1/documents/{doc.id}", headers=headers(other_org, other_user))
    assert deleted.status_code == 404
    assert error_of(deleted).code == "DOCUMENT_NOT_FOUND"
    assert client.delete(f"/v1/documents/{doc.id}", headers=headers(org, user)).status_code == 204
    assert documents_of(client.get("/v1/documents", headers=headers(org, user))) == []


def _answer(
    client: TestClient, org: UUID, user: UUID, question: str
) -> list[TextEvent | SourcesEvent | DoneEvent | object]:
    with client.stream(
        "POST", "/v1/assistant/answers", json={"question": question}, headers=headers(org, user)
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        return [
            AssistantEvent.model_validate_json(line.removeprefix("data: ")).event
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]


def _text(events: list[TextEvent | SourcesEvent | DoneEvent | object]) -> str:
    return "".join(e.text for e in events if isinstance(e, TextEvent)).strip()


def test_the_assistant_streams_an_answer_from_the_workspace_s_documents(client: TestClient) -> None:
    org, user = new_org()
    other_org, other_user = new_org()
    doc = document_of(
        client.post(
            "/v1/documents",
            json={"title": "Handbook", "content": "Refunds take five business days to arrive."},
            headers=headers(org, user),
        )
    )
    client.post(
        "/v1/documents",
        json={"title": "Theirs", "content": "Refunds are instant here."},
        headers=headers(other_org, other_user),
    )
    index_all(client, org)
    index_all(client, other_org)

    events = _answer(client, org, user, "How long do refunds take?")
    assert _text(events) == "From “Handbook”: Refunds take five business days to arrive."
    [sources] = [e for e in events if isinstance(e, SourcesEvent)]
    assert [(s.documentId, s.title) for s in sources.sources] == [(doc.id, "Handbook")]
    done = events[-1]
    assert isinstance(done, DoneEvent)
    assert done.usage.inputTokens > 0

    # The ledger holds the reservation and the settlement; together, what the answer cost.
    rows = as_org(
        org,
        "SELECT feature, model, user_id, sum(input_tokens), sum(output_tokens) FROM ai.usage"
        " WHERE org_id = %s GROUP BY 1, 2, 3",
        (org,),
    )
    assert rows == [
        ("assistant", "local:extractive", user, done.usage.inputTokens, done.usage.outputTokens)
    ]


def test_passages_below_the_relevance_floor_are_never_used(client: TestClient) -> None:
    org, user = new_org()
    client.post(
        "/v1/documents",
        json={"title": "Handbook", "content": "Refunds take five business days to arrive."},
        headers=headers(org, user),
    )
    index_all(client, org)
    events = _answer(client, org, user, "Who founded the company?")
    assert _text(events) == "I couldn't find that in the workspace's documents."
    assert not any(isinstance(e, SourcesEvent) and e.sources for e in events)


def test_a_workspace_over_its_monthly_budget_is_refused(client: TestClient) -> None:
    org, user = new_org()
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'assistant', 'x', 2000000, 0)",
        (org,),
    )
    response = client.post(
        "/v1/assistant/answers", json={"question": "Hello?"}, headers=headers(org, user)
    )
    assert response.status_code == 429
    assert error_of(response).code == "AI_BUDGET_EXCEEDED"


def test_a_workspace_over_its_monthly_budget_gets_no_summary(client: TestClient) -> None:
    from app.main import services

    org, user = new_org()
    doc = document_of(
        client.post(
            "/v1/documents",
            json={"title": "T", "content": "Some text."},
            headers=headers(org, user),
        )
    )
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'assistant', 'x', 2000000, 0)",
        (org,),
    )
    index_all(client, org)
    on_app_loop(client, lambda: services().documents.summarize(org, doc.id, user))
    [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    assert (listed.status, listed.summary) == ("ready", None)
    assert as_org(org, "SELECT count(*) FROM ai.usage WHERE feature = 'summary'") == [(0,)]


def test_the_assistant_is_off_without_a_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    org, user = new_org()
    monkeypatch.delenv("AI_MODEL")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as without:
        response = without.post(
            "/v1/assistant/answers", json={"question": "Hi"}, headers=headers(org, user)
        )
    assert response.status_code == 404
    assert body(response) == {
        "defined": True,
        "code": "FEATURE_DISABLED",
        "status": 404,
        "message": "FEATURE_DISABLED",
        "data": {"params": {"feature": "assistant"}, "requestId": "req-test"},
    }


def test_the_mcp_server_is_off_without_the_api_s_address(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("API_URL")
    get_settings.cache_clear()
    from app.main import app

    with TestClient(app) as without:
        response = without.post("/ai/mcp", json={})
    assert response.status_code == 404
    assert error_of(response).code == "NOT_FOUND"


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


def test_the_worker_indexes_queued_documents_then_summarizes_them(client: TestClient) -> None:
    org, user = new_org()
    doc = document_of(
        client.post(
            "/v1/documents",
            json={
                "title": "Queued",
                "content": "Indexed by the worker. Then summarized.",
            },
            headers=headers(org, user),
        )
    )
    assert doc.summary is None
    with serve({"/v1/traces": otlp_collector, "/v1/metrics": otlp_collector}) as collector:
        # With a collector configured, as in production, so its traces are exported too.
        env = {**os.environ, **ENV, "OTEL_EXPORTER_OTLP_ENDPOINT": collector.url}
        worker = subprocess.Popen([sys.executable, "-m", "app.worker"], env=env)
        try:
            deadline = time.monotonic() + 20
            listed = doc
            while time.monotonic() < deadline and listed.summary is None:
                time.sleep(0.2)
                [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
            assert listed.status == "ready", f"document {doc.id} is {listed.status}"
            # The local summarizer keeps a passage's opening sentence.
            assert listed.summary == "Indexed by the worker."
            # Its liveness probe passes while it runs.
            assert alive()
            [(feature, model, by)] = as_org(
                org,
                "SELECT DISTINCT feature, model, user_id FROM ai.usage WHERE org_id = %s",
                (org,),
            )
            assert (feature, model, by) == ("summary", "local:extractive", user)
        finally:
            worker.terminate()
            assert worker.wait(timeout=10) == 0
    # Spans are sent in batches, and the last batch when the worker stops.
    assert "/v1/traces" in {path for path, _ in collector.received}
