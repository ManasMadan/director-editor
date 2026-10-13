"""The contracts generated from packages/jobs (app/contracts): complete, and tolerant of
what a newer TypeScript side may add during a rolling deploy."""

import importlib
from typing import TypeAliasType
from uuid import uuid4

from pydantic import BaseModel, Field, TypeAdapter

from app.contracts.ai_ingest_ingest_job import AiIngestIngestJob
from app.contracts.ai_ingest_job_name import AiIngestJobName
from app.contracts.shared_queue_name import SharedQueueName
from app.queues import INGEST, SETTINGS, job_options


class _Choices(BaseModel):
    """A Literal's values, as its JSON Schema lists them (`const` when there's one)."""

    const: str | None = None
    enum: list[str] = Field(default_factory=list[str])


def literal_values(alias: TypeAliasType) -> set[str]:
    """The values of a generated `type X = Annotated[Literal[...], ...]`."""
    choices = _Choices.model_validate(TypeAdapter(alias).json_schema())
    return {*choices.enum, *([choices.const] if choices.const else [])}


def test_every_queue_python_uses_is_exported_with_its_settings_and_jobs() -> None:
    assert INGEST in literal_values(SharedQueueName)
    assert literal_values(SharedQueueName) == set(SETTINGS)
    for job in literal_values(AiIngestJobName):
        module = importlib.import_module(f"app.contracts.ai_ingest_{job}_job")
        assert hasattr(module, f"AiIngest{job.title()}Job"), job


def test_an_older_worker_accepts_fields_a_newer_producer_added() -> None:
    document, org = uuid4(), uuid4()
    job = AiIngestIngestJob.model_validate(
        {
            "meta": {"requestId": "r-1", "traceParent": "00-abc"},
            "payload": {"documentId": str(document), "orgId": str(org), "priority": "high"},
        }
    )
    assert (job.payload.documentId, job.payload.orgId, job.meta.requestId) == (document, org, "r-1")


def test_jobs_get_the_typescript_queue_options() -> None:
    options = job_options(INGEST, "doc-1")
    assert options == {
        "attempts": 5,
        "backoff": {"type": "exponential", "delay": 2000},
        "removeOnComplete": {"age": 86400},
        "removeOnFail": {"age": 604800},
        "jobId": "doc-1",
    }
