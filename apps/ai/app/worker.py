"""Background jobs for the AI service: indexing documents (queue `ai-ingest`) and
Director's plans and take reviews (queue `ai-director`, consumed when DIRECTOR_MODEL is
set; until then its jobs wait in the queue).

Run with `bun run worker` (apps/ai). Jobs are validated against the shared contract
before they're processed, and restore the request id they were queued with, so logs
line up with the request that caused them. A failure throws, and BullMQ retries with
the queue's backoff (the same settings the TypeScript side uses).
"""

import asyncio
import signal
from collections.abc import Awaitable, Callable
from contextlib import AbstractContextManager
from typing import Literal, assert_type
from uuid import UUID

import httpx
import structlog
from pydantic import TypeAdapter
from redis.asyncio import Redis

from app.contracts.ai_director_job_name import AiDirectorJobName
from app.contracts.ai_director_plan_job import AiDirectorPlanJob
from app.contracts.ai_director_review_take_job import AiDirectorReviewTakeJob
from app.contracts.ai_ingest_ingest_job import AiIngestIngestJob
from app.contracts.ai_ingest_job_name import AiIngestJobName
from app.contracts.ai_ingest_summarize_job import AiIngestSummarizeJob
from app.db.session import close_engine, open_engine
from app.director import Director, create_director
from app.documents import Documents, create_summaries
from app.embeddings import create_embedder
from app.heartbeat import beat
from app.log import configure_logging, log
from app.queues import (
    DIRECTOR,
    INGEST,
    SETTINGS,
    DirectorQueue,
    IngestQueue,
    JobLike,
    RunningWorker,
    start_worker,
)
from app.settings import get_settings
from app.telemetry import start_telemetry

# A job name this version doesn't know fails the job (and BullMQ keeps it) instead of
# being skipped as if it had run.
JOB_NAME = TypeAdapter[AiIngestJobName](AiIngestJobName)
DIRECTOR_JOB_NAME = TypeAdapter[AiDirectorJobName](AiDirectorJobName)

type AnyJob = AiIngestIngestJob | AiIngestSummarizeJob | AiDirectorPlanJob | AiDirectorReviewTakeJob


def _bound(job: JobLike, data: AnyJob) -> AbstractContextManager[None]:
    """The job's request id and organization on every log line while it runs."""
    return structlog.contextvars.bound_contextvars(
        request_id=data.meta.requestId or f"job:{job.id}", org_id=str(data.payload.orgId)
    )


def _user(data: AnyJob) -> UUID | None:
    return UUID(data.meta.userId) if data.meta.userId else None


def director_processor(director: Director) -> Callable[[JobLike], Awaitable[None]]:
    """Runs one `ai-director` job; on its last attempt, a failure is final."""
    attempts = SETTINGS[DIRECTOR].options.attempts

    async def process(job: JobLike) -> None:
        name = DIRECTOR_JOB_NAME.validate_python(job.name)
        final = job.attemptsMade + 1 >= attempts
        if name == "plan":
            plan = AiDirectorPlanJob.model_validate(job.data)
            with _bound(job, plan):
                await director.analyze(
                    plan.payload.orgId, plan.payload.planId, _user(plan), final=final
                )
        else:
            # The only other job: one added in packages/jobs is a type error here.
            assert_type(name, Literal["review-take"])
            take = AiDirectorReviewTakeJob.model_validate(job.data)
            with _bound(job, take):
                await director.review(
                    take.payload.orgId,
                    take.payload.takeId,
                    str(take.payload.sourceUrl),
                    _user(take),
                    final=final,
                )

    return process


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
    director_queue = DirectorQueue(str(settings.redis_url))
    http = httpx.AsyncClient()
    director = create_director(settings, director_queue, redis, http)
    # Each job is a model watching a video for tens of seconds: a few at once per worker.
    director_worker: RunningWorker | None = (
        start_worker(DIRECTOR, director_processor(director), str(settings.redis_url), concurrency=3)
        if director
        else None
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    # The liveness probe's proof that this loop still runs (app/heartbeat.py).
    heartbeat = asyncio.create_task(beat())
    log.info("ai worker started", queues=[INGEST, DIRECTOR] if director_worker else [INGEST])
    await stop.wait()
    _ = heartbeat.cancel()
    await worker.close()
    if director_worker:
        await director_worker.close()
    await queue.close()
    await director_queue.close()
    await http.aclose()
    await redis.aclose()
    await close_engine()


if __name__ == "__main__":
    asyncio.run(main())
