"""Indexing and summarizing documents at their edges: a document gone before its job
runs, an embedding provider that fails, and no summary model."""

from dataclasses import replace
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.documents import Documents
from tests.support import (
    as_org,
    document_of,
    documents_of,
    headers,
    new_org,
    on_app_loop,
    published,
    stored_job,
    subscribe,
)

pytestmark = pytest.mark.integration


def documents() -> Documents:
    from app.main import services

    return services().documents


def add(client: TestClient, org: UUID, user: UUID) -> UUID:
    response = client.post(
        "/v1/documents",
        json={"title": "Handbook", "content": "Refunds take five days."},
        headers=headers(org, user),
    )
    return document_of(response).id


class ProviderDown:
    name = "down"
    min_score = 0.0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise ConnectionError("the embedding provider went away")


def test_a_document_deleted_before_its_job_runs_is_skipped(client: TestClient) -> None:
    org, user = new_org()
    doc = add(client, org, user)
    assert client.delete(f"/v1/documents/{doc}", headers=headers(org, user)).status_code == 204
    on_app_loop(client, lambda: documents().index(org, doc))
    assert as_org(org, "SELECT count(*) FROM ai.chunk WHERE document_id = %s", (doc,)) == [(0,)]


def test_a_failed_indexing_marks_the_document_and_is_retried(client: TestClient) -> None:
    org, user = new_org()
    doc = add(client, org, user)
    events = subscribe(f"realtime:org:{org}")
    down = replace(documents(), embedder=ProviderDown())
    # Raises, so BullMQ runs the job again with its backoff.
    with pytest.raises(ConnectionError):
        on_app_loop(client, lambda: down.index(org, doc))
    [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    assert (listed.status, listed.error) == ("failed", "DOCUMENT_INDEXING_FAILED")
    # Screens showing the documents hear about it too.
    assert published(events) == [{"type": "documents.changed"}]


def test_without_a_summary_model_indexing_queues_no_summary(client: TestClient) -> None:
    org, user = new_org()
    doc = add(client, org, user)
    unsummarized = replace(documents(), summaries=None)
    on_app_loop(client, lambda: unsummarized.index(org, doc))
    assert stored_job(f"{{ai-ingest}}:ai-ingest:{doc}-summary") == {}
    # A summarize job queued before the model was removed does nothing.
    on_app_loop(client, lambda: unsummarized.summarize(org, doc, user))
    [listed] = documents_of(client.get("/v1/documents", headers=headers(org, user)))
    assert (listed.status, listed.summary) == ("ready", None)
