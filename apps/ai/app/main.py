"""FastAPI entrypoint for the AI service.

Internal: only apps/api calls it, with a typed client generated from this app's OpenAPI
schema (packages/ai-client) and a short-lived token naming the user and organization
(app/auth.py). Browsers never reach it, so end-user auth, rate limits and input limits
stay in the API.

Long work (indexing documents; Director's plans and take reviews) runs in app/worker.py, from
the `ai-ingest` and `ai-director` queues.
"""

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Path, Request, Response
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy import text

from app import model
from app.assistant import Assistant, AssistantEvent, AssistantRequest, create_agent, create_model
from app.auth import CallerDep
from app.contracts.error_response import ErrorResponse
from app.db.models import DirectorPlan, DirectorTake, Document
from app.db.session import close_engine, engine, open_engine
from app.director import Director, create_director
from app.documents import Documents, create_summaries
from app.embeddings import create_embedder
from app.errors import AppError, install_error_handlers
from app.log import configure_logging
from app.queues import DirectorQueue, IngestQueue
from app.schemas import (
    VIDEO_ID_PATTERN,
    DirectorPlanCreate,
    DirectorPlanOut,
    DirectorTakeCreate,
    DirectorTakeOut,
    DocumentCreate,
    DocumentOut,
    HealthResponse,
    SceneCheck,
    SceneCheckRequest,
    SentimentRequest,
    SentimentResponse,
    ShotPlan,
)
from app.settings import get_settings
from app.telemetry import start_telemetry


@dataclass(frozen=True)
class Services:
    """What the app builds at startup, for the routes (typed, unlike Starlette's
    app.state)."""

    redis: Redis
    documents: Documents
    assistant: Assistant | None
    director: Director | None


_services: Services | None = None


def services() -> Services:
    if _services is None:
        raise RuntimeError("the app isn't started (its lifespan builds the services)")
    return _services


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    global _services
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    open_engine(settings.database_url, settings.database_pool_max)
    redis = Redis.from_url(str(settings.redis_url))  # pyright: ignore[reportUnknownMemberType]  # untyped options
    queue = IngestQueue(str(settings.redis_url))
    director_queue = DirectorQueue(str(settings.redis_url))
    http = httpx.AsyncClient()
    documents = Documents(
        create_embedder(settings.embeddings, settings.min_relevance),
        queue,
        redis,
        create_summaries(settings),
    )
    assistant = (
        Assistant(
            create_agent(create_model(settings.model, settings.fallback_model)),
            documents,
            model_name=settings.model,
            monthly_tokens=settings.monthly_tokens_per_org,
            tokens_per_run=settings.tokens_per_run,
        )
        if settings.model
        else None
    )
    _services = Services(
        redis=redis,
        documents=documents,
        assistant=assistant,
        director=create_director(settings, director_queue, redis, http),
    )
    yield
    _services = None
    await queue.close()
    await director_queue.close()
    await http.aclose()
    await redis.aclose()
    await close_engine()


app = FastAPI(
    title="ai",
    version="0.1.0",
    lifespan=lifespan,
    # Every error, from any route, has the contract's shape (app/errors.py); declaring it
    # also replaces FastAPI's default 422 schema, which this service never sends.
    responses={"default": {"model": ErrorResponse, "description": "An error."}},
)
install_error_handlers(app)
start_telemetry("ai", app)


def _documents() -> Documents:
    return services().documents


def _assistant() -> Assistant:
    assistant = services().assistant
    if not assistant:
        raise AppError("FEATURE_DISABLED", {"feature": "assistant"})
    return assistant


def _director() -> Director:
    director = services().director
    if not director:
        raise AppError("FEATURE_DISABLED", {"feature": "director"})
    return director


DocumentsDep = Annotated[Documents, Depends(_documents)]
AssistantDep = Annotated[Assistant, Depends(_assistant)]
DirectorDep = Annotated[Director, Depends(_director)]


def _out(document: Document) -> DocumentOut:
    return DocumentOut(
        id=document.id,
        title=document.title,
        status=document.status,
        error=document.error,
        chunkCount=document.chunk_count,
        summary=document.summary,
        createdBy=document.created_by,
        createdAt=document.created_at,
    )


def _plan_out(plan: DirectorPlan) -> DirectorPlanOut:
    return DirectorPlanOut(
        id=plan.id,
        videoId=plan.video_id,
        status=plan.status,
        error=plan.error,
        plan=ShotPlan.model_validate(plan.plan) if plan.plan is not None else None,
        model=plan.model,
        createdAt=plan.created_at,
        updatedAt=plan.updated_at,
    )


def _take_out(take: DirectorTake) -> DirectorTakeOut:
    return DirectorTakeOut(
        id=take.id,
        shotIndex=take.shot_index,
        fileId=take.file_id,
        kind=take.kind,
        status=take.status,
        error=take.error,
        bestStartMs=take.best_start_ms,
        bestEndMs=take.best_end_ms,
        score=take.score,
        feedback=take.feedback,
        createdAt=take.created_at,
    )


@app.get("/health/live", operation_id="live")
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@app.get("/health/ready", operation_id="ready")
def ready() -> HealthResponse:
    """Serving requests. Not the dependencies: they're shared, so an outage of one would
    take every pod out of rotation at once (see /health/dependencies)."""
    return HealthResponse(status="ok")


@app.get("/health/dependencies", operation_id="dependencies")
async def dependencies() -> HealthResponse:
    """Postgres and Redis answer: for dashboards and start-up scripts."""
    async with engine().connect() as connection:
        await connection.execute(text("SELECT 1"))
    # Any reply will do, and an outage raises. ECHO rather than PING: redis-py types ping
    # as "a bool or an awaitable of one", which can't be awaited without a cast.
    await services().redis.echo("ready")  # pyright: ignore[reportUnknownMemberType]  # untyped options
    return HealthResponse(status="ok")


# `operation_id` becomes the operation name in the generated TypeScript client.
# Plain `def`: inference is blocking work, so FastAPI runs it in a thread pool.
@app.post("/v1/sentiment", operation_id="sentiment")
def sentiment(body: SentimentRequest, _caller: CallerDep) -> SentimentResponse:
    label, score = model.predict(body.text)
    return SentimentResponse(label=label, score=score, model=model.MODEL_ID)


@app.get("/v1/documents", operation_id="listDocuments")
async def list_documents(caller: CallerDep, documents: DocumentsDep) -> list[DocumentOut]:
    return [_out(d) for d in await documents.list(caller.org_id)]


@app.post("/v1/documents", operation_id="createDocument", status_code=201)
async def create_document(
    body: DocumentCreate, caller: CallerDep, documents: DocumentsDep, request: Request
) -> DocumentOut:
    document = await documents.create(
        caller.org_id,
        caller.user_id,
        body.title,
        body.content,
        request.headers.get("x-request-id"),
    )
    return _out(document)


@app.delete("/v1/documents/{document_id}", operation_id="deleteDocument", status_code=204)
async def delete_document(
    document_id: UUID, caller: CallerDep, documents: DocumentsDep
) -> Response:
    await documents.delete(caller.org_id, document_id)
    return Response(status_code=204)


@app.post(
    "/v1/assistant/answers",
    operation_id="answer",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "Server-sent events, each `data:` line one AssistantEvent.",
            "model": AssistantEvent,
            "content": {"text/event-stream": {}},
        }
    },
)
async def answer(
    body: AssistantRequest, caller: CallerDep, assistant: AssistantDep
) -> StreamingResponse:
    # Reserved before streaming starts, so an exhausted budget is a normal error response.
    # A client that leaves before the stream starts leaves the reservation counted as spent.
    reservation = await assistant.reserve(caller.org_id, caller.user_id)

    async def events() -> AsyncIterator[str]:
        async for event in assistant.answer(reservation, body.question):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
    )


@app.post("/v1/director/plans", operation_id="requestDirectorPlan")
async def request_director_plan(
    body: DirectorPlanCreate, caller: CallerDep, director: DirectorDep, request: Request
) -> DirectorPlanOut:
    """The workspace's plan for a short; asking queues its analysis when there is none."""
    plan = await director.request_plan(
        caller.org_id, caller.user_id, body.videoId, request.headers.get("x-request-id")
    )
    return _plan_out(plan)


@app.get("/v1/director/plans/{video_id}", operation_id="getDirectorPlan")
async def get_director_plan(
    video_id: Annotated[str, Path(pattern=VIDEO_ID_PATTERN)],
    caller: CallerDep,
    director: DirectorDep,
) -> DirectorPlanOut:
    return _plan_out(await director.plan(caller.org_id, video_id))


@app.post("/v1/director/scene-checks", operation_id="checkDirectorScene")
async def check_director_scene(
    body: SceneCheckRequest, caller: CallerDep, director: DirectorDep
) -> SceneCheck:
    """Where to go for a shot, judged from one camera frame."""
    return await director.check_scene(
        caller.org_id, caller.user_id, body.videoId, body.shotIndex, body.image
    )


@app.post("/v1/director/takes", operation_id="createDirectorTake", status_code=201)
async def create_director_take(
    body: DirectorTakeCreate, caller: CallerDep, director: DirectorDep, request: Request
) -> DirectorTakeOut:
    """Records a take and queues its review."""
    take = await director.add_take(
        caller.org_id, caller.user_id, body, request.headers.get("x-request-id")
    )
    return _take_out(take)


@app.get("/v1/director/plans/{video_id}/takes", operation_id="listDirectorTakes")
async def list_director_takes(
    video_id: Annotated[str, Path(pattern=VIDEO_ID_PATTERN)],
    caller: CallerDep,
    director: DirectorDep,
) -> list[DirectorTakeOut]:
    """The caller's takes for the short's plan, newest first."""
    return [_take_out(t) for t in await director.takes(caller.org_id, caller.user_id, video_id)]
