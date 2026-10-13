"""Background jobs for the AI service: indexing documents (queue `ai-ingest`).

Run with `bun run worker` (apps/ai). Jobs are validated against the shared contract
before they're processed, and restore the request id they were queued with, so logs
line up with the request that caused them. A failure throws, and BullMQ retries with
the queue's backoff (the same settings the TypeScript side uses).
"""

import asyncio
import signal
from contextlib import AbstractContextManager
from typing import Literal, assert_type
from uuid import UUID

import structlog
from pydantic import TypeAdapter
from redis.asyncio import Redis

from app.contracts.ai_ingest_ingest_job import AiIngestIngestJob
from app.contracts.ai_ingest_job_name import AiIngestJobName
from app.contracts.ai_ingest_summarize_job import AiIngestSummarizeJob
from app.db.session import close_engine, open_engine
from app.documents import Documents, create_summaries
from app.embeddings import create_embedder
from app.heartbeat import beat
from app.log import configure_logging, log
from app.queues import INGEST, IngestQueue, JobLike, start_worker
from app.settings import get_settings
from app.telemetry import start_telemetry

# A job name this version doesn't know fails the job (and BullMQ keeps it) instead of
# being skipped as if it had run.
JOB_NAME = TypeAdapter[AiIngestJobName](AiIngestJobName)


def _bound(
    job: JobLike, data: AiIngestIngestJob | AiIngestSummarizeJob
) -> AbstractContextManager[None]:
    """The job's request id and organization on every log line while it runs."""
    return structlog.contextvars.bound_contextvars(
        request_id=data.meta.requestId or f"job:{job.id}", org_id=str(data.payload.orgId)
    )


def _user(data: AiIngestIngestJob | AiIngestSummarizeJob) -> UUID | None:
    return UUID(data.meta.userId) if data.meta.userId else None


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    start_telemetry("ai-worker")
    open_engine(settings.database_url, settings.database_pool_max)
    redis = Redis.from_url(str(settings.redis_url))  # pyright: ignore[reportUnknownMemberType]  # untyped options
    queue = IngestQueue(str(settings.redis_url))
    documents = Documents(
        create_embedder(settings.embeddings, settings.min_relevance),
        queue,
        redis,
        create_summaries(settings),
    )

    async def process(job: JobLike) -> None:
        name = JOB_NAME.validate_python(job.name)
        if name == "ingest":
            ingest = AiIngestIngestJob.model_validate(job.data)
            with _bound(job, ingest):
                await documents.index(
                    ingest.payload.orgId,
                    ingest.payload.documentId,
                    request_id=ingest.meta.requestId,
                    user_id=_user(ingest),
                )
        else:
            # The only other job: one added in packages/jobs is a type error here.
            assert_type(name, Literal["summarize"])
            summarize = AiIngestSummarizeJob.model_validate(job.data)
            with _bound(job, summarize):
                await documents.summarize(
                    summarize.payload.orgId, summarize.payload.documentId, _user(summarize)
                )

    worker = start_worker(INGEST, process, str(settings.redis_url), concurrency=4)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    # The liveness probe's proof that this loop still runs (app/heartbeat.py).
    heartbeat = asyncio.create_task(beat())
    log.info("ai worker started", queue=INGEST)
    await stop.wait()
    _ = heartbeat.cancel()
    await worker.close()
    await queue.close()
    await redis.aclose()
    await close_engine()


if __name__ == "__main__":
    asyncio.run(main())
