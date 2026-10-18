"""FastAPI entrypoint for the AI service.

Internal: only apps/api calls it, with a typed client generated from this app's OpenAPI
schema (packages/ai-client) and a short-lived token naming the user and organization
(app/auth.py). Browsers never reach it, so end-user auth, rate limits and input limits
stay in the API.

Long work (Director's plans and take reviews) runs in app/worker.py, from the
`ai-director` queue.
"""

from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Path, Request, Response
from pydantic import TypeAdapter
from redis.asyncio import Redis
from sqlalchemy import text

from app.auth import CallerDep
from app.clipping import Clipper, LocalClipper, RemoteClipper, clip_response
from app.contracts.error_response import ErrorResponse
from app.db.models import DirectorAsset, DirectorCut, DirectorPlan, DirectorTake
from app.db.session import close_engine, engine, open_engine
from app.director import Director, create_director
from app.errors import AppError, install_error_handlers
from app.log import configure_logging
from app.queues import DirectorQueue
from app.schemas import (
    ASSET_ID_PATTERN,
    MAX_ASSET_ID,
    VIDEO_ID_PATTERN,
    AssetCandidateCreate,
    AssetCandidateOut,
    AssetChoiceCreate,
    AssetDrawingCreate,
    AssetImageOut,
    ClipRequest,
    AssetSlotsOut,
    CutPick,
    DirectorCutCreate,
    DirectorCutOut,
    DirectorLibraryOut,
    DirectorPlanCreate,
    DirectorPlanOut,
    DirectorTakeCreate,
    DirectorTakeOut,
    HealthResponse,
    Located,
    LocateRequest,
    PublishCopy,
    PublishCopyRequest,
    SceneCheck,
    SceneCheckRequest,
    ShotPlan,
    SpeechRequest,
)
from app.settings import get_settings
from app.speech import Speaker, create_speaker
from app.telemetry import start_telemetry


@dataclass(frozen=True)
class Services:
    """What the app builds at startup, for the routes (typed, unlike Starlette's
    app.state)."""

    redis: Redis
    director: Director | None
    speaker: Speaker | None
    clipper: Clipper


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
    director_queue = DirectorQueue(str(settings.redis_url))
    http = httpx.AsyncClient()
    _services = Services(
        redis=redis,
        director=create_director(settings, director_queue, redis, http),
        speaker=create_speaker(settings),
        # Recorded attempts are cut on the Cloud Run clipper when CLIPPER_URL names it,
        # off this machine; otherwise here, the same way.
        clipper=RemoteClipper(settings.clipper_url, http)
        if settings.clipper_url
        else LocalClipper(http),
    )
    yield
    _services = None
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


def _director() -> Director:
    director = services().director
    if not director:
        raise AppError("FEATURE_DISABLED", {"feature": "director"})
    return director


DirectorDep = Annotated[Director, Depends(_director)]


def _speaker() -> Speaker:
    # Director's voice is part of Director: on and off with it.
    speaker = services().speaker
    if not speaker:
        raise AppError("FEATURE_DISABLED", {"feature": "director"})
    return speaker


SpeakerDep = Annotated[Speaker, Depends(_speaker)]


def _plan_out(plan: DirectorPlan, images: Sequence[DirectorAsset] = ()) -> DirectorPlanOut:
    return DirectorPlanOut(
        id=plan.id,
        videoId=plan.video_id,
        source=plan.source,
        status=plan.status,
        stage=plan.stage,
        error=plan.error,
        plan=ShotPlan.model_validate(plan.plan) if plan.plan is not None else None,
        model=plan.model,
        audioStatus=plan.audio_status,
        audioKey=plan.audio_key,
        assetImages=[
            AssetImageOut(assetId=image.asset_id, status=image.status, objectKey=image.object_key)
            for image in images
        ],
        createdAt=plan.created_at,
        updatedAt=plan.updated_at,
    )


_PICKS = TypeAdapter(list[CutPick])


def _cut_out(cut: DirectorCut, plan: DirectorPlan) -> DirectorCutOut:
    return DirectorCutOut(
        id=cut.id,
        planId=plan.id,
        videoId=plan.video_id,
        # A cut is only ever made of a ready plan, and a ready plan stays ready.
        templateTitle=ShotPlan.model_validate(plan.plan).title,
        title=cut.title,
        picks=_PICKS.validate_python(cut.picks),
        fileId=cut.file_id,
        durationMs=cut.duration_ms,
        publishStatus=cut.publish_status,
        youtubeVideoId=cut.youtube_video_id,
        visibility=cut.visibility,
        createdAt=cut.created_at,
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
@app.post("/v1/director/plans", operation_id="indexDirectorPlan")
async def index_director_plan(
    body: DirectorPlanCreate, caller: CallerDep, director: DirectorDep, request: Request
) -> DirectorPlanOut:
    """The workspace's plan for a short; asking queues its analysis when there is none,
    as the caller's one short of their own (DIRECTOR_INDEX_LIMIT past it)."""
    plan = await director.index(
        caller.org_id, caller.user_id, body.videoId, request.headers.get("x-request-id")
    )
    return _plan_out(plan)


@app.get("/v1/director/library", operation_id="getDirectorLibrary")
async def get_director_library(caller: CallerDep, director: DirectorDep) -> DirectorLibraryOut:
    """The workspace's plans, and whether the caller has indexed their own short."""
    plans, used = await director.library(caller.org_id, caller.user_id)
    return DirectorLibraryOut(templates=[_plan_out(plan) for plan in plans], indexUsed=used)


@app.get("/v1/director/plans/{video_id}", operation_id="getDirectorPlan")
async def get_director_plan(
    video_id: Annotated[str, Path(pattern=VIDEO_ID_PATTERN)],
    caller: CallerDep,
    director: DirectorDep,
) -> DirectorPlanOut:
    """The workspace's plan for a short, with the default images of its assets."""
    plan = await director.plan(caller.org_id, video_id)
    return _plan_out(plan, await director.asset_images(caller.org_id, plan))


@app.post("/v1/director/scene-checks", operation_id="checkDirectorScene")
async def check_director_scene(
    body: SceneCheckRequest, caller: CallerDep, director: DirectorDep
) -> SceneCheck:
    """Where to go for a shot, judged from one camera frame."""
    return await director.check_scene(
        caller.org_id, caller.user_id, body.videoId, body.shotIndex, body.image
    )


@app.post("/v1/director/locate", operation_id="locateDirectorTarget")
async def locate_director_target(
    body: LocateRequest, caller: CallerDep, director: DirectorDep
) -> Located:
    """Where something Director names is in one camera frame, for a mark on screen."""
    return await director.locate(caller.org_id, caller.user_id, body.target, body.image)


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


@app.post("/v1/director/cuts", operation_id="createDirectorCut", status_code=201)
async def create_director_cut(
    body: DirectorCutCreate, caller: CallerDep, director: DirectorDep
) -> DirectorCutOut:
    """Records a cut of the caller's, from their takes picked one per shot."""
    cut, plan = await director.save_cut(caller.org_id, caller.user_id, body)
    return _cut_out(cut, plan)


@app.get("/v1/director/plans/{video_id}/cuts", operation_id="listDirectorCuts")
async def list_director_cuts(
    video_id: Annotated[str, Path(pattern=VIDEO_ID_PATTERN)],
    caller: CallerDep,
    director: DirectorDep,
) -> list[DirectorCutOut]:
    """The caller's cuts of the short, newest first."""
    return [_cut_out(*row) for row in await director.cuts(caller.org_id, caller.user_id, video_id)]


@app.get("/v1/director/cuts", operation_id="listDirectorMedia")
async def list_director_media(caller: CallerDep, director: DirectorDep) -> list[DirectorCutOut]:
    """Every cut of the caller's, newest first."""
    return [_cut_out(*row) for row in await director.cuts(caller.org_id, caller.user_id, None)]


@app.post(
    "/v1/director/speak",
    operation_id="speakDirectorLine",
    response_class=Response,
    responses={
        200: {
            "content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}},
            "description": "The line, spoken, as a WAV file.",
        }
    },
)
async def speak_director_line(
    body: SpeechRequest, caller: CallerDep, speaker: SpeakerDep
) -> Response:
    """A line in Director's voice (Gemini's text-to-speech), as a WAV file."""
    audio = await speaker.speak(caller.org_id, caller.user_id, body.text, body.voice)
    return Response(content=audio, media_type="audio/wav")


@app.get("/v1/director/cuts/{cut_id}", operation_id="getDirectorCut")
async def get_director_cut(
    cut_id: UUID, caller: CallerDep, director: DirectorDep
) -> DirectorCutOut:
    """One of the caller's cuts (DIRECTOR_CUT_NOT_FOUND unless it's theirs)."""
    return _cut_out(*await director.cut(caller.org_id, caller.user_id, cut_id))


@app.post("/v1/director/publish-copy", operation_id="writeDirectorPublishCopy")
async def write_director_publish_copy(
    body: PublishCopyRequest, caller: CallerDep, director: DirectorDep
) -> PublishCopy:
    """Gemini's YouTube post for one of the caller's cuts: a title, a description and
    hashtags in the Short's language, and the credits to the original."""
    return await director.publish_copy(caller.org_id, caller.user_id, body)


@app.post(
    "/v1/director/clips",
    operation_id="clipDirectorAttempt",
    response_class=Response,
    responses={
        200: {
            "content": {"video/mp4": {"schema": {"type": "string", "format": "binary"}}},
            "description": (
                "The attempt's take, an MP4; where it was cut in the part's clock in the"
                " x-clip-start-ms and x-clip-end-ms headers."
            ),
        }
    },
)
async def clip_director_attempt(body: ClipRequest, _caller: CallerDep) -> Response:
    """Cuts a recorded attempt out of its session's footage into a take: Director's marks
    snapped to the first and last words, never across a pause (RECORDING_CLIP_FAILED when
    there's nothing to cut; UPSTREAM_UNAVAILABLE while the footage can't be reached)."""
    return await clip_response(services().clipper, body)


# ------------------------------------------------------------------------ asset picker
VideoIdPath = Annotated[str, Path(pattern=VIDEO_ID_PATTERN)]
AssetIdPath = Annotated[str, Path(pattern=ASSET_ID_PATTERN, max_length=MAX_ASSET_ID)]


@app.get("/v1/director/plans/{video_id}/assets", operation_id="listDirectorAssets")
async def list_director_assets(
    video_id: VideoIdPath, caller: CallerDep, director: DirectorDep
) -> AssetSlotsOut:
    """Every asset slot of the plan, with its default and the caller's own images, the one
    each uses, and the caller's images left."""
    return await director.picker.slots(caller.org_id, caller.user_id, video_id)


@app.post(
    "/v1/director/plans/{video_id}/assets/{asset_id}/drawings",
    operation_id="drawDirectorAsset",
    status_code=201,
)
async def draw_director_asset(
    video_id: VideoIdPath,
    asset_id: AssetIdPath,
    body: AssetDrawingCreate,
    caller: CallerDep,
    director: DirectorDep,
) -> AssetCandidateOut:
    """Queues an image for the slot drawn from the caller's prompt, or an edit of another
    of its images (DIRECTOR_IMAGE_LIMIT past the caller's images)."""
    return await director.picker.draw(caller.org_id, caller.user_id, video_id, asset_id, body)


@app.post(
    "/v1/director/plans/{video_id}/assets/{asset_id}/images",
    operation_id="addDirectorAsset",
    status_code=201,
)
async def add_director_asset(
    video_id: VideoIdPath,
    asset_id: AssetIdPath,
    body: AssetCandidateCreate,
    caller: CallerDep,
    director: DirectorDep,
) -> AssetCandidateOut:
    """Records an upload of the caller's, or a stock picture, for the slot."""
    return await director.picker.add(caller.org_id, caller.user_id, video_id, asset_id, body)


@app.post(
    "/v1/director/plans/{video_id}/assets/{asset_id}/choice",
    operation_id="chooseDirectorAsset",
    status_code=204,
)
async def choose_director_asset(
    video_id: VideoIdPath,
    asset_id: AssetIdPath,
    body: AssetChoiceCreate,
    caller: CallerDep,
    director: DirectorDep,
) -> Response:
    """The image the caller's video uses in the slot (none: its default)."""
    await director.picker.choose(caller.org_id, caller.user_id, video_id, asset_id, body)
    return Response(status_code=204)
