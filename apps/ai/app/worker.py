"""Background jobs for the AI service: Director's plans, their images and take reviews (queue
`ai-director`, consumed when DIRECTOR_MODEL is set; until then its jobs wait in the
queue).

Run with `bun run worker` (apps/ai). Jobs are validated against the shared contract
before they're processed, and restore the request id, workspace and user they were
queued with, so logs line up with the request that caused them; each run writes a
`job.finished` activity line (app/activity.py). A failure throws, and BullMQ retries with
the queue's backoff (the same settings the TypeScript side uses).
"""

import asyncio
import signal
import time
from collections.abc import Awaitable, Callable
from contextlib import AbstractContextManager
from typing import Literal, assert_type
from uuid import UUID

import httpx
import structlog
from pydantic import TypeAdapter
from redis.asyncio import Redis

from app.activity import Target, log_activity
from app.contracts.ai_director_assets_job import AiDirectorAssetsJob
from app.contracts.ai_director_job_name import AiDirectorJobName
from app.contracts.ai_director_plan_job import AiDirectorPlanJob
from app.contracts.ai_director_review_take_job import AiDirectorReviewTakeJob
from app.db.session import close_engine, open_engine
from app.director import Director, create_director
from app.heartbeat import beat
from app.log import configure_logging, log
from app.queues import (
    DIRECTOR,
    SETTINGS,
    DirectorQueue,
    JobLike,
    RunningWorker,
    start_worker,
)
from app.settings import get_settings
from app.telemetry import start_telemetry

# A job name this version doesn't know fails the job (and BullMQ keeps it) instead of
# being skipped as if it had run.
DIRECTOR_JOB_NAME = TypeAdapter[AiDirectorJobName](AiDirectorJobName)

type AnyJob = AiDirectorPlanJob | AiDirectorAssetsJob | AiDirectorReviewTakeJob


def _bound(job: JobLike, data: AnyJob) -> AbstractContextManager[None]:
    """The job's request id, workspace and user on every log line while it runs."""
    user = {"userId": data.meta.userId} if data.meta.userId else {}
    return structlog.contextvars.bound_contextvars(
        requestId=data.meta.requestId or f"job:{job.id}", orgId=str(data.payload.orgId), **user
    )


def _user(data: AnyJob) -> UUID | None:
    return UUID(data.meta.userId) if data.meta.userId else None


async def run_job(job: JobLike, final: bool, work: Callable[[], Awaitable[None]]) -> None:
    """Runs a job's work and writes its `job.finished` activity line, however it ends: the
    same line the Node workers write, for the user it ran for (bound by `_bound`)."""
    target: Target = {
        "queue": DIRECTOR,
        "job": job.name,
        "jobId": job.id,
        # BullMQ's count of the runs before this one.
        "attempt": job.attemptsMade + 1,
    }
    started = time.monotonic()
    try:
        await work()
    except Exception as error:
        log_activity(
            "job.finished",
            outcome="failed",
            reason=type(error).__name__,
            target={**target, "final": final},
            duration_ms=(time.monotonic() - started) * 1000,
        )
        raise
    log_activity("job.finished", target=target, duration_ms=(time.monotonic() - started) * 1000)


def director_processor(director: Director) -> Callable[[JobLike], Awaitable[None]]:
    """Runs one `ai-director` job; on its last attempt, a failure is final."""
    attempts = SETTINGS[DIRECTOR].options.attempts

    async def process(job: JobLike) -> None:
        name = DIRECTOR_JOB_NAME.validate_python(job.name)
        final = job.attemptsMade + 1 >= attempts
        if name == "plan":
            plan = AiDirectorPlanJob.model_validate(job.data)
            with _bound(job, plan):
                await run_job(
                    job,
                    final,
                    lambda: director.analyze(
                        plan.payload.orgId, plan.payload.planId, _user(plan), final=final
                    ),
                )
        elif name == "assets":
            assets = AiDirectorAssetsJob.model_validate(job.data)
            with _bound(job, assets):
                await director.make_assets(assets.payload.orgId, assets.payload.planId, final=final)
        else:
            # The only other job: one added in packages/jobs is a type error here.
            assert_type(name, Literal["review-take"])
            take = AiDirectorReviewTakeJob.model_validate(job.data)
            with _bound(job, take):
                await run_job(
                    job,
                    final,
                    lambda: director.review(
                        take.payload.orgId,
                        take.payload.takeId,
                        str(take.payload.sourceUrl),
                        _user(take),
                        final=final,
                    ),
                )

    return process


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    start_telemetry("ai-worker")
    open_engine(settings.database_url, settings.database_pool_max)
    redis = Redis.from_url(str(settings.redis_url))  # pyright: ignore[reportUnknownMemberType]  # untyped options
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
    log.info("ai worker started", queues=[DIRECTOR] if director_worker else [])
    await stop.wait()
    _ = heartbeat.cancel()
    if director_worker:
        await director_worker.close()
    await director_queue.close()
    await http.aclose()
    await redis.aclose()
    await close_engine()


if __name__ == "__main__":
    asyncio.run(main())
