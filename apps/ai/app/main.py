"""FastAPI entrypoint for the AI service.

Internal: only apps/api calls it, with a typed client generated from this app's OpenAPI
schema (packages/ai-client) and a short-lived token naming the user and organization
(app/auth.py). Browsers never reach it, so end-user auth, rate limits and input limits
stay in the API. The one exception is the MCP server at /ai/mcp (app/mcp_server.py),
which MCP clients reach through the gateway and which checks OAuth tokens itself.

Long work (indexing documents) runs in app/worker.py from the `ai-ingest` queue.
"""

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from redis.asyncio import Redis
from sqlalchemy import text
from starlette.types import ASGIApp, Receive, Scope, Send

from app import model
from app.assistant import Assistant, AssistantEvent, AssistantRequest, create_agent, create_model
from app.auth import CallerDep
from app.contracts.error_response import ErrorResponse
from app.db.models import Document
from app.db.session import close_engine, engine, open_engine
from app.documents import Documents, create_summaries
from app.embeddings import create_embedder
from app.errors import AppError, install_error_handlers
from app.log import configure_logging
from app.mcp_server import MCP_PATHS, create_mcp_server, mcp_app
from app.queues import IngestQueue
from app.schemas import (
    DocumentCreate,
    DocumentOut,
    HealthResponse,
    SentimentRequest,
    SentimentResponse,
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
    mcp: ASGIApp | None


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
    documents = Documents(
        create_embedder(settings.embeddings, settings.min_relevance),
        queue,
        redis,
        create_summaries(settings),
    )
    exit_stack = AsyncExitStack()
    mcp: ASGIApp | None = None
    if settings.site_url and settings.api_url:
        server = create_mcp_server(
            site_url=str(settings.site_url),
            api_url=str(settings.api_url),
            release=settings.release,
            documents=lambda: documents,
            redis=lambda: redis,
        )
        mcp = mcp_app(server)
        await exit_stack.enter_async_context(server.session_manager.run())
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
    _services = Services(redis=redis, documents=documents, assistant=assistant, mcp=mcp)
    yield
    _services = None
    await exit_stack.aclose()
    await queue.close()
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


async def _mcp(scope: Scope, receive: Receive, send: Send) -> None:
    """Hands requests for /ai/mcp and its protected-resource metadata to the MCP server
    built at startup. Anything else, and everything when the server is off, is an
    unknown route."""
    server = services().mcp
    if server is None or scope.get("path") not in MCP_PATHS:
        raise AppError("NOT_FOUND")
    await server(scope, receive, send)


def _documents() -> Documents:
    return services().documents


def _assistant() -> Assistant:
    assistant = services().assistant
    if not assistant:
        raise AppError("FEATURE_DISABLED", {"feature": "assistant"})
    return assistant


DocumentsDep = Annotated[Documents, Depends(_documents)]
AssistantDep = Annotated[Assistant, Depends(_assistant)]


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


# Registered last, so every route above takes precedence.
app.mount("/", _mcp)
