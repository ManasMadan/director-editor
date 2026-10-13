"""The queues this service uses, configured from packages/jobs: the queue and job names,
each job's payload model, the Redis prefix and the job options are all generated from
the TypeScript definitions (app/contracts), so both languages agree on where jobs live,
what they carry and how they retry.

BullMQ's Node and Python packages are upgraded as a pair (the Python one is pinned in
pyproject.toml). They keep a queue's state in the same Redis keys and change it with the
same Lua scripts, so versions whose scripts differ can corrupt a queue the other side is
using; tests/test_bullmq_pair.py fails when they do. The Python package's blocking
connection also doesn't read the Redis version, so a delayed job can start up to a
second late on this side.
"""

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal, Protocol, assert_type
from uuid import UUID

# bullmq's source is typed but ships without a py.typed marker, so pyright treats it as
# stub-less; its calls are confined to this module, behind typed wrappers.
from bullmq import Queue, Worker  # pyright: ignore[reportMissingTypeStubs]
from bullmq.types import (  # pyright: ignore[reportMissingTypeStubs]
    JobOptions,
    QueueBaseOptions,
    WorkerOptions,
)
from pydantic import TypeAdapter

from app.contracts.ai_ingest_ingest_job import AiIngestIngestJob
from app.contracts.ai_ingest_job_name import AiIngestJobName
from app.contracts.ai_ingest_summarize_job import AiIngestSummarizeJob
from app.contracts.queue_setting import QueueSetting
from app.contracts.shared_queue_name import SharedQueueName

SETTINGS = TypeAdapter(dict[SharedQueueName, QueueSetting]).validate_json(
    (Path(__file__).parent / "contracts" / "queue_settings.json").read_bytes()
)
INGEST: SharedQueueName = "ai-ingest"
_JOB_OPTIONS = TypeAdapter(JobOptions)


def job_options(queue: SharedQueueName, job_id: str) -> JobOptions:
    """The queue's shared job options, as bullmq's own options type."""
    options = SETTINGS[queue].options.model_dump(mode="json", exclude_none=True)
    return _JOB_OPTIONS.validate_python({**options, "jobId": job_id})


class IngestQueue:
    def __init__(self, redis_url: str) -> None:
        options: QueueBaseOptions = {"connection": redis_url, "prefix": SETTINGS[INGEST].prefix}
        self._queue = Queue(INGEST, options)

    async def add(
        self,
        name: AiIngestJobName,
        document_id: UUID,
        org_id: UUID,
        *,
        request_id: str | None,
        user_id: UUID | None,
    ) -> None:
        job = {
            "meta": {
                "requestId": request_id,
                "userId": str(user_id) if user_id else None,
                "orgId": str(org_id),
            },
            "payload": {"documentId": document_id, "orgId": org_id},
        }
        # One job per document and step: queuing the same step twice runs it once.
        if name == "ingest":
            data = AiIngestIngestJob.model_validate(job)
            job_id = str(document_id)
        else:
            # The only other job: one added in packages/jobs is a type error here.
            assert_type(name, Literal["summarize"])
            data = AiIngestSummarizeJob.model_validate(job)
            job_id = f"{document_id}-summary"
        await self._queue.add(  # pyright: ignore[reportUnknownMemberType]  # bullmq leaves the job's data untyped
            name, data.model_dump(mode="json", exclude_none=True), job_options(INGEST, job_id)
        )

    async def close(self) -> None:
        await self._queue.close()


class JobLike(Protocol):
    id: str | None
    name: str
    data: object


class RunningWorker(Protocol):
    async def close(self) -> None: ...


def start_worker(
    queue: SharedQueueName,
    handle: Callable[[JobLike], Awaitable[None]],
    redis_url: str,
    concurrency: int,
) -> RunningWorker:
    async def process(job: JobLike, _token: str) -> None:
        await handle(job)

    options: WorkerOptions = {
        "connection": redis_url,
        "prefix": SETTINGS[queue].prefix,
        "concurrency": concurrency,
    }
    # bullmq types the processor as returning a Future; any coroutine function works.
    return Worker(queue, process, options)  # pyright: ignore[reportArgumentType]  # see above
