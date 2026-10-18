"""The Cloud Run clipper: cuts one recorded attempt into a take per request, off the VM, so
decoding a session's footage and encoding the take don't hold the machine the API and
its workers share.

    uvicorn app.clipper:app --host 0.0.0.0 --port 8080      (docs/deploy.md)

The same image as the service (ffmpeg is in it), another entrypoint. It has no
database, Redis, storage or caller secret: the AI service (app/clipping.py's
RemoteClipper, for apps/worker) sends the attempt's marks, its pauses and presigned
reads of its footage, and gets back the take as an MP4, with where it was cut in the
`x-clip-start-ms` and `x-clip-end-ms` headers. An attempt that can't be cut answers
RECORDING_CLIP_FAILED; footage it can't reach for now, 502 UPSTREAM_UNAVAILABLE.

Private: Cloud Run lets in only the service's invokers (`--no-allow-unauthenticated`),
and every request is checked again here: an ID token Google signed, for this service's
URL (CLIPPER_URL), from the one account allowed (CLIPPER_INVOKER, the VM's).
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Header, Response

from app.clipping import LocalClipper, clip_response
from app.contracts.error_response import ErrorResponse
from app.errors import AppError, install_error_handlers
from app.google_auth import verify_invoker
from app.log import configure_logging
from app.schemas import ClipRequest, HealthResponse
from app.settings import ClipperSettings, get_clipper_settings
from app.telemetry import start_telemetry


@dataclass(frozen=True)
class ClipperServices:
    settings: ClipperSettings
    clipper: LocalClipper


_services: ClipperServices | None = None


def services() -> ClipperServices:
    if _services is None:
        raise RuntimeError("the clipper isn't started (its lifespan builds the services)")
    return _services


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    global _services
    settings = get_clipper_settings()
    configure_logging(settings.log_level, json=settings.node_env == "production")
    async with httpx.AsyncClient() as http:
        _services = ClipperServices(settings=settings, clipper=LocalClipper(http))
        yield
        _services = None


app = FastAPI(
    title="ai-clipper",
    version="0.1.0",
    lifespan=lifespan,
    # Private, and only ever called by the AI service: nothing to browse.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    responses={"default": {"model": ErrorResponse, "description": "An error."}},
)
install_error_handlers(app)
start_telemetry("ai-clipper", app)


async def invoker(authorization: Annotated[str | None, Header()] = None) -> None:
    """The caller is the account allowed to clip (UNAUTHENTICATED, FORBIDDEN)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise AppError("UNAUTHENTICATED")
    settings = services().settings
    await verify_invoker(
        authorization.removeprefix("Bearer "),
        audience=settings.clipper_url,
        invoker=settings.clipper_invoker,
        certs_url=str(settings.google_certs_url),
    )


@app.get("/health/live", operation_id="live")
def live() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/v1/clip", operation_id="clip", dependencies=[Depends(invoker)])
async def clip(body: ClipRequest) -> Response:
    return await clip_response(services().clipper, body)
