"""The contracts generated from packages/jobs (app/contracts): complete, and tolerant of
what a newer TypeScript side may add during a rolling deploy."""

import importlib
from typing import TypeAliasType
from uuid import uuid4

from pydantic import BaseModel, Field, TypeAdapter

from app.contracts.ai_director_job_name import AiDirectorJobName
from app.contracts.ai_director_plan_job import AiDirectorPlanJob
from app.contracts.shared_queue_name import SharedQueueName
from app.queues import DIRECTOR, SETTINGS, job_options


class _Choices(BaseModel):
    """A Literal's values, as its JSON Schema lists them (`const` when there's one)."""

    const: str | None = None
    enum: list[str] = Field(default_factory=list[str])


def literal_values(alias: TypeAliasType) -> set[str]:
    """The values of a generated `type X = Annotated[Literal[...], ...]`."""
    choices = _Choices.model_validate(TypeAdapter(alias).json_schema())
    return {*choices.enum, *([choices.const] if choices.const else [])}


def _class_name(job: str) -> str:
    return "AiDirector" + "".join(part.title() for part in job.split("-")) + "Job"


def test_every_queue_python_uses_is_exported_with_its_settings_and_jobs() -> None:
    assert DIRECTOR in literal_values(SharedQueueName)
    assert literal_values(SharedQueueName) == set(SETTINGS)
    for job in literal_values(AiDirectorJobName):
        module = importlib.import_module(f"app.contracts.ai_director_{job.replace('-', '_')}_job")
        assert hasattr(module, _class_name(job)), job


def test_an_older_worker_accepts_fields_a_newer_producer_added() -> None:
    plan, org = uuid4(), uuid4()
    job = AiDirectorPlanJob.model_validate(
        {
            "meta": {"requestId": "r-1", "traceParent": "00-abc"},
            "payload": {"planId": str(plan), "orgId": str(org), "priority": "high"},
        }
    )
    assert (job.payload.planId, job.payload.orgId, job.meta.requestId) == (plan, org, "r-1")


def test_jobs_get_the_typescript_queue_options() -> None:
    options = job_options(DIRECTOR, "plan-1")
    assert options == {
        "attempts": 3,
        "backoff": {"type": "exponential", "delay": 5000},
        "removeOnComplete": {"age": 86400},
        "removeOnFail": {"age": 604800},
        "jobId": "plan-1",
    }
