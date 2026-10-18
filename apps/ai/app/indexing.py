"""Indexing a short: Gemini watches it and writes its shot plan, and its original audio is
captured. One implementation (`index_short`, wrapped by `LocalIndexer`), run either in
the worker or on Cloud Run (app/indexer.py), so the long video calls happen off the VM.

Seam: `Indexer` is what a plan job (app/director.py's `Director.analyze`) calls.
`LocalIndexer` indexes in this process; `RemoteIndexer` sends the same request to the
Cloud Run indexer, which runs a `LocalIndexer` and answers with its result. The worker
picks one from INDEXER_URL (app/director.py's `create_indexer`); another place to run
indexing is another `Indexer`, and the plan job doesn't change.

Either way a run ends in an `IndexResult` or an `IndexFailed`, both carrying what the
run used, so the worker counts every run against the workspace's budget (app/usage.py)
wherever it ran.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol

import httpx
from pydantic import ValidationError
from pydantic_ai import Agent, VideoUrl
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.usage import RunUsage, UsageLimits

from app.audio import fetch_audio
from app.contracts.error_response import ErrorCode, ErrorResponse
from app.google_auth import id_token
from app.log import log
from app.plan_repair import repair_plan
from app.schemas import (
    AudioCapture,
    IndexRequest,
    IndexResult,
    ShotPlan,
    ShotPlanDraft,
    TokenUsage,
)

# The statuses Gemini refuses a request with (a bad request, a key it won't take, an unknown
# model): not worth a retry. When the refusal is about the video (private, removed,
# age-restricted), the member is told so; otherwise it's this service's configuration.
REFUSED_STATUSES = frozenset({400, 403, 404})
_VIDEO_WORDS = ("video", "youtube", "file_uri", "url")
# Indexing watches a short unattended (no member waiting), so a transient failure is
# worth a couple of immediate retries before falling back to a different model, rather
# than failing the whole job over one bad response from INDEX_MODEL.
PLANNER_RETRIES = 2
PLANNER_RETRY_BACKOFF_SECONDS = 1.0
# The statuses worth trying the index fallback model for straight away, no retry: the
# model itself refused the request (a bad key, a model it doesn't recognize) rather than
# the video, so a different model (or the key it's configured with) might succeed where
# this one didn't. 401 is always about the model; 403/404 only when they aren't about the
# video (REFUSED_STATUSES' own distinction).
_FALLBACK_STATUSES = frozenset({401, 403, 404})
# Three frames a second is plenty for a shot plan (it's reading cuts and poses, not fine
# print), and keeps the request well under Gemini's token budget for a long short.
INDEX_VIDEO_FPS = 3.0
# As long as Cloud Run lets the indexer answer (`--timeout` in docs/deploy.md): every
# retry and the fallback of a slow short fit in it.
INDEX_REQUEST_SECONDS = 900.0

# Why a run ended without a plan, as the plan's error: the video can't be watched, or
# anything else (which includes an outage that outlasted its retries).
type IndexFailure = Literal["DIRECTOR_VIDEO_UNAVAILABLE", "DIRECTOR_ANALYSIS_FAILED"]
# Called once the plan is written, while the rest (the audio, saving) is still to come.
type Watched = Callable[[], Awaitable[None]]
NOTHING_USED = TokenUsage(inputTokens=0, outputTokens=0)


def youtube_video(video_id: str) -> VideoUrl:
    # A YouTube page has no container type, and Vertex AI answers a YouTube URL sent as
    # video/mp4 (what VideoUrl infers) with a 500; video/* works there and on the Gemini API.
    # fps: VideoMetadata.fps, verified on Vertex to reach the request.
    return VideoUrl(
        url=f"https://www.youtube.com/watch?v={video_id}",
        media_type="video/*",
        vendor_metadata={"fps": INDEX_VIDEO_FPS},
    )


def retryable(error: BaseException) -> bool:
    """Whether trying again may succeed: an outage, a timeout, or being told to slow down.
    A refusal, an answer that breaks its contract or a take that isn't one won't change."""
    if isinstance(error, ModelHTTPError):
        return error.status_code == 429 or error.status_code >= 500
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code >= 500
    return isinstance(error, (httpx.TransportError, ModelAPIError, TimeoutError))


def _about_the_video(error: ModelHTTPError) -> bool:
    """Whether a refusal's own body is about the video (private, removed, age-restricted)
    rather than this service's configuration (a bad key, a model it doesn't recognize)."""
    about = str(error.body or "").lower()
    return any(word in about for word in _VIDEO_WORDS)


def _refusal_code(error: ModelHTTPError) -> IndexFailure | None:
    """The plan's error for a refused request: the video's fault, or this service's. A
    video YouTube's API still lists but Gemini can't watch (private, removed,
    age-restricted) is the same to the member as a link that's no good."""
    if error.status_code not in REFUSED_STATUSES:
        return None
    if _about_the_video(error):
        return "DIRECTOR_VIDEO_UNAVAILABLE"
    log.error("gemini refused a plan request", status=error.status_code, body=error.body)
    return "DIRECTOR_ANALYSIS_FAILED"


def _falls_back_to_the_other_model(error: BaseException) -> bool:
    """Worth trying the index fallback model for, straight away, no retry on the same
    model first: a refusal that's about the model (an auth error, or a 403/404 that isn't
    about the video) might not happen on the other one, where a refusal about the video
    itself would happen on either."""
    if not isinstance(error, ModelHTTPError) or error.status_code not in _FALLBACK_STATUSES:
        return False
    return error.status_code == 401 or not _about_the_video(error)


async def index_short(
    planner: Agent[None, ShotPlanDraft],
    planner_name: str,
    planner_fallback: Agent[None, ShotPlanDraft],
    fallback_name: str,
    video_id: str,
    usage: RunUsage,
    usage_limits: UsageLimits,
) -> tuple[ShotPlan, str]:
    """Watches `video_id` with `planner` and returns its repaired shot plan and the name
    of whichever model actually wrote it: `planner_name`, or `fallback_name` once
    `planner`'s retries are spent or it refuses in a way `planner_fallback` might not
    (`_falls_back_to_the_other_model`). Retries a transient failure (a 5xx or 429) on
    `planner` a couple more times with a short backoff before falling back, with no retry
    on `planner_fallback` first. Anything else (a refusal about the video, a broken
    contract) isn't retried and doesn't fall back: a different model watching the same
    video wouldn't fix what's wrong with the video.

    One implementation of "index a short into a usable plan", shared by the plan job
    (`LocalIndexer`, in the worker or on Cloud Run) and the seed-building script
    (apps/ai/scripts/build_seeds.py, which builds its own pair of agents and a budget of
    its own instead of a reservation's)."""
    messages = [youtube_video(video_id), "Write the shot plan for this short."]
    last_error: Exception | None = None
    for attempt in range(PLANNER_RETRIES + 1):
        try:
            result = await planner.run(messages, usage=usage, usage_limits=usage_limits)
            return repair_plan(result.output, None), planner_name
        except Exception as error:
            last_error = error
            if _falls_back_to_the_other_model(error):
                break
            if not retryable(error):
                raise
            if attempt < PLANNER_RETRIES:
                await asyncio.sleep(PLANNER_RETRY_BACKOFF_SECONDS * (attempt + 1))
    log.warning(
        "falling back to the index fallback model", video_id=video_id, error=str(last_error)
    )
    result = await planner_fallback.run(messages, usage=usage, usage_limits=usage_limits)
    return repair_plan(result.output, None), fallback_name


class IndexFailed(Exception):
    """A run that ended without a plan: why (the plan's error), whether trying again may
    succeed, and what it used, which counts all the same."""

    def __init__(
        self, code: IndexFailure, *, retryable: bool, usage: TokenUsage, cause: str
    ) -> None:
        super().__init__(f"{code}: {cause}")
        self.code: IndexFailure = code
        self.retryable = retryable
        self.usage = usage


class Indexer(Protocol):
    async def index(self, request: IndexRequest, *, watched: Watched) -> IndexResult:
        """The short's plan (IndexFailed when there's none to be had), calling `watched`
        once Gemini has answered."""
        ...


def _used(usage: RunUsage) -> TokenUsage:
    return TokenUsage(inputTokens=usage.input_tokens, outputTokens=usage.output_tokens)


class LocalIndexer:
    """Indexes in this process: INDEX_MODEL's planner, INDEX_FALLBACK_MODEL's once its
    retries are spent, and the audio captured into `media_bucket` (none without one)."""

    def __init__(
        self,
        planner: Agent[None, ShotPlanDraft],
        planner_name: str,
        planner_fallback: Agent[None, ShotPlanDraft],
        fallback_name: str,
        media_bucket: str | None,
    ) -> None:
        # The short names the caller built each model from, not the agents' own: on
        # Vertex those are the full resource name, and the plan keeps the short one.
        self._planner, self._planner_name = planner, planner_name
        self._fallback, self._fallback_name = planner_fallback, fallback_name
        self._media_bucket = media_bucket

    async def index(self, request: IndexRequest, *, watched: Watched) -> IndexResult:
        usage = RunUsage()
        try:
            # Retries, falls back, and repairs what Gemini's plan validates field by field
            # but can still leave inconsistent with itself (overlapping shots, a script
            # line past its shot's end, more shots or steps than the prompt asked for).
            plan, model = await index_short(
                self._planner,
                self._planner_name,
                self._fallback,
                self._fallback_name,
                request.videoId,
                usage,
                UsageLimits(total_tokens_limit=request.maxTokens),
            )
        except Exception as error:
            # Includes the run's token cap: a short needing more would spend it again.
            refused = _refusal_code(error) if isinstance(error, ModelHTTPError) else None
            if refused is None:
                log.exception("indexing a short failed", plan_id=str(request.planId))
            raise IndexFailed(
                refused or "DIRECTOR_ANALYSIS_FAILED",
                retryable=retryable(error),
                usage=_used(usage),
                cause=str(error),
            ) from error
        await watched()
        return IndexResult(
            plan=plan, model=model, audio=await self._audio(request.videoId), usage=_used(usage)
        )

    async def _audio(self, video_id: str) -> AudioCapture:
        """The short's original audio, captured after the plan (a short whose plan failed
        needs none); a capture that fails leaves the plan as it is."""
        if self._media_bucket is None:
            return AudioCapture(status="none", objectKey=None)
        key = await fetch_audio(video_id, self._media_bucket)
        return AudioCapture(status="ready" if key else "failed", objectKey=key)


class RemoteIndexer:
    """Sends the request to the Cloud Run indexer at `url` (app/indexer.py), as this
    machine's service account: an ID token for `url` from the metadata server, which
    Cloud Run's IAM and the indexer itself both check.

    Stage timing: the indexer can't reach this worker's realtime channel, so `watched`
    (the plan's `writing` stage) is called only once its answer arrives, just before the
    plan is saved; `watching` covers the whole remote run, the audio capture included."""

    def __init__(self, url: str, http: httpx.AsyncClient) -> None:
        self._url = url
        self._http = http

    async def index(self, request: IndexRequest, *, watched: Watched) -> IndexResult:
        unknown = _all_reserved(request)
        try:
            token = await id_token(self._url)
        except httpx.HTTPError as error:
            # Nothing was sent: no token from the metadata server, so nothing ran.
            raise _unreachable("the metadata server", error, NOTHING_USED) from error
        try:
            response = await self._http.post(
                f"{self._url}/v1/index",
                content=request.model_dump_json(),
                headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
                timeout=INDEX_REQUEST_SECONDS,
            )
        except httpx.HTTPError as error:
            # Never connected: nothing ran. Once the request was sent (a timeout, a dropped
            # connection), what the indexer did and used is unknown: the whole reservation
            # counts.
            used = NOTHING_USED if isinstance(error, _NEVER_SENT) else unknown
            raise _unreachable("the indexer", error, used) from error
        if not response.is_success:
            raise _refused(response, unknown)
        try:
            result = IndexResult.model_validate_json(response.content)
        except ValidationError as error:
            # Another version of the indexer (it's deployed by hand): what it answered
            # can't be stored, and asking again would get the same.
            log.warning("the indexer's answer isn't an IndexResult", errors=error.error_count())
            raise IndexFailed(
                "DIRECTOR_ANALYSIS_FAILED", retryable=False, usage=unknown, cause=str(error)
            ) from error
        await watched()
        return result


# Errors that mean the request never reached the indexer.
_NEVER_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


def _unreachable(what: str, error: httpx.HTTPError, used: TokenUsage) -> IndexFailed:
    """A run that couldn't get an answer: worth trying again, the next may get through."""
    log.warning("couldn't reach " + what, error=f"{type(error).__name__}: {error}")
    return IndexFailed("DIRECTOR_ANALYSIS_FAILED", retryable=True, usage=used, cause=str(error))


def _all_reserved(request: IndexRequest) -> TokenUsage:
    """A run's usage when it can't be known: everything it was allowed."""
    return TokenUsage(inputTokens=request.maxTokens, outputTokens=0)


def _refused(response: httpx.Response, unknown: TokenUsage) -> IndexFailed:
    """The indexer's error answer as the run's failure. Its own (this service's error
    shape) says why and what the run used; anything else is Cloud Run's: its IAM refusing
    this account or the service busy (nothing ran), or the service failing or timing out
    (a 5xx: the run's outcome, and usage, unknown). Either is worth a retry only for an
    outage."""
    status = response.status_code
    try:
        error: ErrorResponse | None = ErrorResponse.model_validate_json(response.content)
    except ValidationError:
        error = None
    if error is None:
        code: IndexFailure = "DIRECTOR_ANALYSIS_FAILED"
        usage = unknown if status >= 500 else NOTHING_USED
    else:
        code = _plan_error(error.code)
        usage = _usage_in(error, unknown)
    log.warning("the indexer failed a short", status=status, code=error.code if error else None)
    return IndexFailed(
        code,
        retryable=status == 429 or status >= 500,
        usage=usage,
        cause=f"the indexer answered {status}",
    )


def _usage_in(error: ErrorResponse, unknown: TokenUsage) -> TokenUsage:
    """What the indexer says the run used (its error's params), or `unknown` when they
    don't say it in a form this version reads."""
    try:
        return TokenUsage.model_validate(
            {key: error.data.params.get(key, 0) for key in ("inputTokens", "outputTokens")}
        )
    except ValidationError:
        log.warning("the indexer's error doesn't say what the run used", code=error.code)
        return unknown


def _plan_error(code: ErrorCode) -> IndexFailure:
    """The indexer's code, when it's a reason a plan fails with (anything else, such as
    its refusing this caller, is this service's own failure)."""
    return (
        "DIRECTOR_VIDEO_UNAVAILABLE"
        if code == "DIRECTOR_VIDEO_UNAVAILABLE"
        else "DIRECTOR_ANALYSIS_FAILED"
    )
