"""The Cloud Run aligner: lines up one match cut per request, off the VM, so decoding the
takes and the OpenCV work don't hold the machine the API and its workers share.

    uvicorn app.aligner:app --host 0.0.0.0 --port 8080      (docs/deploy.md)

The same image as the service (ffmpeg and OpenCV are in it), another entrypoint. It has
no database, Redis, storage or caller secret: the service (app/aligning.py's
RemoteAligner) sends the cut, presigned reads of the two takes and the tokens it reserved,
and gets back the alignment and what the Gemini call used, which it counts.

Private: Cloud Run lets in only the service's invokers (`--no-allow-unauthenticated`),
and every request is checked again here: an ID token Google signed, for this service's
URL (ALIGNER_URL), from the one account allowed (ALIGNER_INVOKER, the VM's).
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, FastAPI, Header

from app.aligning import LocalAligner, create_locator
from app.contracts.error_response import ErrorResponse
from app.director import create_google_model
from app.errors import AppError, install_error_handlers
from app.google_auth import verify_invoker
from app.log import configure_logging
from app.schemas import AlignRequest, AlignResult, HealthResponse
from app.settings import AlignerSettings, get_aligner_settings
from app.telemetry import start_telemetry


@dataclass(frozen=True)
class AlignerServices:
    settings: AlignerSettings
    aligner: LocalAligner


_services: AlignerServices | None = None


def services() -> AlignerServices:
    if _services is None:
        raise RuntimeError("the aligner isn't started (its lifespan builds the services)")
    return _services


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    global _services
    settings = get_aligner_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    model = create_google_model(settings, settings.director_model)
    _services = AlignerServices(settings=settings, aligner=LocalAligner(create_locator(model)))
    yield
    _services = None


app = FastAPI(
    title="ai-aligner",
    version="0.1.0",
    lifespan=lifespan,
    # Private, and only ever called by the service: nothing to browse.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    responses={"default": {"model": ErrorResponse, "description": "An error."}},
)
install_error_handlers(app)
start_telemetry("ai-aligner", app)


async def invoker(authorization: Annotated[str | None, Header()] = None) -> None:
    """The caller is the account allowed to align (UNAUTHENTICATED, FORBIDDEN)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError("UNAUTHENTICATED")
    settings = services().settings
    await verify_invoker(
        authorization.removeprefix("Bearer "),
        audience=settings.aligner_url,
        invoker=settings.aligner_invoker,
        certs_url=str(settings.google_certs_url),
    )


@app.get("/health/live", operation_id="live")
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/v1/align", operation_id="align", dependencies=[Depends(invoker)])
async def align(body: AlignRequest) -> AlignResult:
    return await services().aligner.align(body)
