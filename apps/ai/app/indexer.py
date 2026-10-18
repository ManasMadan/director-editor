"""The Cloud Run indexer: indexes one short per request, off the VM, so Gemini's long
video calls and the audio download don't hold the worker's machine.

    uvicorn app.indexer:app --host 0.0.0.0 --port 8080      (docs/deploy.md)

The same image as the service, another entrypoint. It has no database, Redis or caller
secret: the worker (app/indexing.py's RemoteIndexer) sends the short, the token cap it
reserved and ids for the logs, and gets back the plan, the model that wrote it, the
audio it captured into MEDIA_BUCKET, and what the run used; the worker stores all of it
and counts the usage. A failure answers with its reason (the plan's error code), status
502 when the worker should try again, and what the run used in the error's params
(`inputTokens`, `outputTokens`), which count all the same.

Private: Cloud Run lets in only the service's invokers (`--no-allow-unauthenticated`),
and every request is checked again here: an ID token Google signed, for this service's
URL (INDEXER_URL), from the one account allowed (INDEXER_INVOKER, the VM's).
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated

import structlog
from fastapi import Depends, FastAPI, Header

from app.contracts.error_response import ErrorResponse
from app.director import create_local_indexer
from app.errors import AppError, install_error_handlers
from app.google_auth import verify_invoker
from app.indexing import IndexFailed, LocalIndexer
from app.log import configure_logging
from app.schemas import HealthResponse, IndexRequest, IndexResult
from app.settings import IndexerSettings, get_indexer_settings
from app.telemetry import start_telemetry


@dataclass(frozen=True)
class IndexerServices:
    settings: IndexerSettings
    indexer: LocalIndexer


_services: IndexerServices | None = None


def services() -> IndexerServices:
    if _services is None:
        raise RuntimeError("the indexer isn't started (its lifespan builds the services)")
    return _services


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    global _services
    settings = get_indexer_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    _services = IndexerServices(settings=settings, indexer=create_local_indexer(settings))
    yield
    _services = None


app = FastAPI(
    title="ai-indexer",
    version="0.1.0",
    lifespan=lifespan,
    responses={"default": {"model": ErrorResponse, "description": "An error."}},
)
install_error_handlers(app)
start_telemetry("ai-indexer", app)


async def invoker(authorization: Annotated[str | None, Header()] = None) -> None:
    """The caller is the account allowed to index (UNAUTHENTICATED, FORBIDDEN)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError("UNAUTHENTICATED")
    settings = services().settings
    await verify_invoker(
        authorization.removeprefix("Bearer "),
        audience=settings.indexer_url,
        invoker=settings.indexer_invoker,
        certs_url=str(settings.google_certs_url),
    )


@app.get("/health/live", operation_id="live")
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/v1/index", operation_id="index", dependencies=[Depends(invoker)])
async def index(body: IndexRequest) -> IndexResult:
    """The short's plan, and its audio when MEDIA_BUCKET is set."""
    structlog.contextvars.bind_contextvars(
        org_id=str(body.orgId), plan_id=str(body.planId), video_id=body.videoId
    )
    try:
        return await services().indexer.index(body, watched=_nothing_to_announce)
    except IndexFailed as failure:
        used = {
            "inputTokens": failure.usage.inputTokens,
            "outputTokens": failure.usage.outputTokens,
        }
        if failure.retryable:
            raise AppError("UPSTREAM_UNAVAILABLE", {"service": "gemini", **used}) from None
        raise AppError(failure.code, used) from None


async def _nothing_to_announce() -> None:
    """The worker announces each stage itself: it hears of this one with the answer."""
