"""The post-session pass's way into a recording session (app/session_pass.py's
`RecordingSource` and `AttemptSink`), against continuous recording's tables in the `app`
schema, which apps/api owns: this service may read a session's parts, slices and attempts
and add attempts, nothing more (the grants in 20261018221000_director_take_picks).

The footage stays where the shoot screen uploaded it, in ten-second slices of each part
(`recordings/<session>/<part>/<slice>`, the bucket MEDIA_BUCKET names, which is the one
apps/api stores them in). Gemini needs each part as one recording, so the part's stored
slices are joined in Cloud Storage itself (compose: no bytes pass through here, and a
recorder's slices joined in order are its recording, as the clipper joins them) into one
object Gemini on Vertex reads from its gs:// URI. Those joined copies are deleted once
the pass is done.

An attempt the pass adds is an ordinary attempt of the session marked `origin = 'pass'`
with Gemini's reason; it goes on the `recording` queue like one apps/api queues, and
apps/worker cuts it into a take, which the AI service then marks as found by the pass.
"""

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol
from uuid import UUID

from bullmq import Queue  # pyright: ignore[reportMissingTypeStubs]  # no stubs shipped
from bullmq.types import QueueBaseOptions  # pyright: ignore[reportMissingTypeStubs]
from google.cloud import storage  # pyright: ignore[reportMissingTypeStubs]  # no stubs shipped
from pydantic import BaseModel, TypeAdapter
from redis.asyncio import Redis
from sqlalchemy import text

from app.contracts.realtime_message import DirectorChanged
from app.contracts.recording_clip_job import RecordingClipJob
from app.contracts.recording_job_name import RecordingJobName
from app.db.models import DirectorPlan
from app.db.session import tenant
from app.director import create_google_model
from app.log import log
from app.queues import SETTINGS, job_options
from app.realtime import publish_to_org
from app.schemas import ShotPlan
from app.session_pass import (
    GeminiWatcher,
    KnownAttempt,
    NewAttempt,
    NoRecordings,
    PartFootage,
    Refinement,
    SessionFootage,
    SessionPass,
)
from app.settings import Settings
from app.usage import Allowance, Reservation, reserve, settle

RECORDING = "recording"
CHANGED = DirectorChanged(type="director.changed")
# Cloud Storage composes at most this many objects at once; more are joined in rounds.
COMPOSE_MOST = 32


class _Session(BaseModel):
    user_id: UUID
    plan_id: UUID
    status: str


class PartRow(BaseModel):
    index: int
    camera: Literal["front", "back"]
    content_type: Literal["video/webm", "video/mp4"]


class SliceRow(BaseModel):
    part_index: int
    index: int
    start_ms: int
    duration_ms: int


class _Attempt(BaseModel):
    id: UUID
    part_index: int
    shot_index: int
    start_ms: int
    end_ms: int | None
    status: str
    origin: str


_PARTS = TypeAdapter(list[PartRow])
_SLICES = TypeAdapter(list[SliceRow])
_ATTEMPTS = TypeAdapter(list[_Attempt])
_MADE = TypeAdapter[UUID | None](UUID | None)


@dataclass(frozen=True)
class StoredPart:
    """A part's stored slices, from the first, with no gap: what plays as one recording."""

    index: int
    camera: Literal["front", "back"]
    content_type: Literal["video/webm", "video/mp4"]
    keys: list[str]
    duration_ms: int


class Joiner(Protocol):
    async def join(self, keys: Sequence[str], into: str, content_type: str) -> str:
        """Joins the stored objects at `keys`, in order, into `into`; its gs:// URI."""
        ...

    async def remove(self, keys: Sequence[str]) -> None: ...


class Clips(Protocol):
    async def add_clip(self, org_id: UUID, attempt_id: UUID, user_id: UUID) -> None:
        """Queues the attempt to be cut into a take (the `recording` queue's `clip`)."""
        ...


def slice_key(session_id: UUID, part: int, index: int) -> str:
    """Where a slice is stored (packages/contracts recording.ts `recordingSliceKey`)."""
    return f"recordings/{session_id}/{part}/{index}"


def stored_parts(
    parts: Sequence[PartRow], slices: Sequence[SliceRow], session_id: UUID
) -> list[StoredPart]:
    """Each part's uploaded slices from the first up to the first one missing: footage
    after a gap can't be played without what's in it. A part with none is left out."""
    found: list[StoredPart] = []
    for part in parts:
        mine = sorted((s for s in slices if s.part_index == part.index), key=lambda s: s.index)
        run: list[SliceRow] = []
        for expected, piece in enumerate(mine):
            if piece.index != expected:
                break
            run.append(piece)
        if run:
            last = run[-1]
            found.append(
                StoredPart(
                    index=part.index,
                    camera=part.camera,
                    content_type=part.content_type,
                    keys=[slice_key(session_id, part.index, s.index) for s in run],
                    duration_ms=last.start_ms + last.duration_ms,
                )
            )
    return found


class GcsJoiner:
    """Cloud Storage compose, with Application Default Credentials (the service's own
    account), in the bucket the slices are stored in."""

    def __init__(self, bucket: str) -> None:
        self._bucket = bucket

    async def join(self, keys: Sequence[str], into: str, content_type: str) -> str:
        await asyncio.to_thread(self._compose, list(keys), into, content_type)
        return f"gs://{self._bucket}/{into}"

    def _compose(self, keys: list[str], into: str, content_type: str) -> None:
        bucket = storage.Client().bucket(self._bucket)  # pyright: ignore[reportUnknownMemberType]  # untyped client
        # Each round joins up to COMPOSE_MOST pieces, the first being what's joined so far.
        joined: list[str] = []
        pending = keys
        while pending:
            take = COMPOSE_MOST - len(joined)
            sources = [bucket.blob(key) for key in [*joined, *pending[:take]]]  # pyright: ignore[reportUnknownMemberType]  # untyped client
            target = bucket.blob(into)  # pyright: ignore[reportUnknownMemberType]  # untyped client
            target.content_type = content_type
            target.compose(sources)  # pyright: ignore[reportUnknownMemberType]  # untyped client
            joined, pending = [into], pending[take:]

    async def remove(self, keys: Sequence[str]) -> None:
        await asyncio.to_thread(self._delete, list(keys))

    def _delete(self, keys: list[str]) -> None:
        bucket = storage.Client().bucket(self._bucket)  # pyright: ignore[reportUnknownMemberType]  # untyped client
        for key in keys:
            bucket.blob(key).delete()  # pyright: ignore[reportUnknownMemberType]  # untyped client


class ClipQueue:
    """The `recording` queue, as apps/api adds to it: the attempt's id is the job's, so an
    attempt is cut once however often it's queued."""

    def __init__(self, redis_url: str) -> None:
        options: QueueBaseOptions = {"connection": redis_url, "prefix": SETTINGS[RECORDING].prefix}
        self._queue = Queue(RECORDING, options)

    async def add_clip(self, org_id: UUID, attempt_id: UUID, user_id: UUID) -> None:
        data = RecordingClipJob.model_validate(
            {
                "meta": {"orgId": str(org_id), "userId": str(user_id)},
                "payload": {"attemptId": attempt_id, "orgId": org_id},
            }
        )
        # The job's name, checked against the queue's contract (packages/jobs).
        name: RecordingJobName = "clip"
        await self._queue.add(  # pyright: ignore[reportUnknownMemberType]  # bullmq leaves the job's data untyped
            name,
            data.model_dump(mode="json", exclude_none=True),
            job_options(RECORDING, str(attempt_id)),
        )

    async def close(self) -> None:
        await self._queue.close()


class DbRecordings:
    """A finished session's footage and attempts, read from the database and joined in
    storage; the attempts the pass finds, added and queued to be cut."""

    def __init__(self, joiner: Joiner, clips: Clips) -> None:
        self._joiner = joiner
        self._clips = clips
        # What each session's footage was joined into, to remove once the pass is done.
        self._joined: dict[UUID, list[str]] = {}
        self._users: dict[UUID, UUID] = {}

    async def footage(self, org_id: UUID, session_id: UUID) -> SessionFootage | None:
        async with tenant(org_id) as db:
            found = (
                (
                    await db.execute(
                        text(
                            "SELECT user_id, plan_id, status FROM app.recording_session"
                            " WHERE id = :id"
                        ),
                        {"id": session_id},
                    )
                )
                .mappings()
                .first()
            )
            if found is None:
                return None
            session = _Session.model_validate(dict(found))
            if session.status != "done":
                return None
            plan = await db.get(DirectorPlan, session.plan_id)
            parts = _PARTS.validate_python(
                [
                    dict(row)
                    for row in (
                        await db.execute(
                            text(
                                "SELECT index, camera, content_type FROM app.recording_part"
                                " WHERE session_id = :id ORDER BY index"
                            ),
                            {"id": session_id},
                        )
                    ).mappings()
                ]
            )
            slices = _SLICES.validate_python(
                [
                    dict(row)
                    for row in (
                        await db.execute(
                            text(
                                "SELECT part_index, index, start_ms, duration_ms"
                                " FROM app.recording_slice"
                                " WHERE session_id = :id AND status = 'uploaded'"
                            ),
                            {"id": session_id},
                        )
                    ).mappings()
                ]
            )
            attempts = _ATTEMPTS.validate_python(
                [
                    dict(row)
                    for row in (
                        await db.execute(
                            text(
                                "SELECT id, part_index, shot_index, start_ms, end_ms, status,"
                                " origin FROM app.recording_attempt WHERE session_id = :id"
                                " ORDER BY number"
                            ),
                            {"id": session_id},
                        )
                    ).mappings()
                ]
            )
        if plan is None or plan.plan is None:
            return None
        # An attempt an earlier run of the pass added and then failed to queue (the queue
        # unreachable a moment) is among the known ones now, so it won't be added again:
        # queued here instead, or it's never cut. The queue's job id is the attempt's, so
        # one that was queued is cut once all the same.
        for stranded in (a for a in attempts if a.origin == "pass" and a.status == "clipping"):
            await self._clips.add_clip(org_id, stranded.id, session.user_id)
        stored = stored_parts(parts, slices, session_id)
        joined: list[PartFootage] = []
        self._joined[session_id] = []
        for part in stored:
            into = f"recordings/{session_id}/{part.index}/whole"
            uri = await self._joiner.join(part.keys, into, part.content_type)
            self._joined[session_id].append(into)
            joined.append(
                PartFootage(part.index, part.camera, uri, part.content_type, part.duration_ms)
            )
        self._users[session_id] = session.user_id
        return SessionFootage(
            user_id=session.user_id,
            plan=ShotPlan.model_validate(plan.plan),
            parts=joined,
            known=[
                KnownAttempt(a.id, a.part_index, a.shot_index, a.start_ms, a.end_ms)
                for a in attempts
            ],
        )

    async def add(self, org_id: UUID, session_id: UUID, attempt: NewAttempt) -> None:
        async with tenant(org_id) as db:
            made = _MADE.validate_python(
                await db.scalar(
                    text(
                        "INSERT INTO app.recording_attempt (org_id, session_id, number, shot_index,"
                        " part_index, line, start_ms, end_ms, status, origin, reason, updated_at)"
                        " SELECT :org, :session, coalesce(max(number), 0) + 1, :shot, :part, :line,"
                        " :start, :end, 'clipping', 'pass', :reason, now()"
                        " FROM app.recording_attempt WHERE session_id = :session"
                        " ON CONFLICT (session_id, part_index, start_ms) DO NOTHING RETURNING id"
                    ),
                    {
                        "org": org_id,
                        "session": session_id,
                        "shot": attempt.shot_index,
                        "part": attempt.part,
                        "line": attempt.line[:300] if attempt.line else None,
                        "start": attempt.start_ms,
                        "end": attempt.end_ms,
                        "reason": attempt.reason,
                    },
                )
            )
        if made is None:
            # Added by a run of the pass before this one, which queued it then.
            return
        await self._clips.add_clip(org_id, made, self._users[session_id])

    async def refine(self, org_id: UUID, session_id: UUID, refinement: Refinement) -> None:
        # A marked attempt is already a take the member may have watched or picked;
        # cutting it again would swap the take under them. Its edges were snapped to
        # speech when it was cut, so the pass's are only logged, to judge whether
        # re-cutting is worth building.
        log.info(
            "the pass would move an attempt's edges",
            session_id=str(session_id),
            attempt_id=str(refinement.attempt_id),
            start_ms=refinement.start_ms,
            end_ms=refinement.end_ms,
        )

    async def done(self, session_id: UUID) -> None:
        """Removes the joined copies of the session's footage: the slices stay, on their
        own retention."""
        joined = self._joined.pop(session_id, [])
        self._users.pop(session_id, None)
        if joined:
            await self._joiner.remove(joined)


def create_session_pass(settings: Settings, redis: Redis) -> tuple[SessionPass, ClipQueue] | None:
    """The pass and the queue it adds attempts to (closed with the worker), on with
    Director (DIRECTOR_MODEL). It watches long footage unattended, so it uses the model
    that indexes shorts (INDEX_MODEL). Without MEDIA_BUCKET there's nowhere to join the
    footage in, and the pass goes through nothing."""
    if not settings.director_model:
        return None
    model_name = settings.index_model
    allowance = Allowance(settings.monthly_tokens_per_org, settings.monthly_tokens_per_demo_guest)

    async def reserve_pass(org_id: UUID, user_id: UUID | None, most: int) -> Reservation | None:
        # Its whole size or nothing: a pass sized from its footage can't make do with less.
        return await reserve(
            org_id,
            user_id,
            "director-pass",
            model_name,
            most=most,
            allowance=allowance,
            least=most,
        )

    async def changed(org_id: UUID) -> None:
        await publish_to_org(redis, org_id, CHANGED)

    clips = ClipQueue(str(settings.redis_url))
    watcher = GeminiWatcher(create_google_model(settings, model_name), reserve_pass, settle)
    if settings.media_bucket is None:
        stand_in = NoRecordings()
        return SessionPass(watcher, stand_in, stand_in, changed), clips
    recordings = DbRecordings(GcsJoiner(settings.media_bucket), clips)
    return SessionPass(watcher, recordings, recordings, changed), clips
