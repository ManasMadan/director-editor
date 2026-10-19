"""The post-session pass's way into a recording (app/session_recordings.py), against the
real database and Redis: a finished session's footage read and joined, the attempts the
pass adds, queued to be cut once, and the joined copies removed; Cloud Storage's
compose and delete against the local stand-in (tests/fakes.py)."""

import asyncio
from collections.abc import Sequence
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, TypeAdapter

from app.queues import ClipQueue
from app.session_pass import NewAttempt, PartFootage, Refinement
from app.session_recordings import COMPOSE_MOST, DbRecordings, GcsJoiner, slice_key
from tests.fakes import MEDIA_BUCKET, Reply, serve
from tests.support import REDIS_URL, as_org, migrator, new_org, on_app_loop, stored_job
from tests.test_director import VIDEO, insert_plan

pytestmark = pytest.mark.integration

_JSON = TypeAdapter(object)


class Joins:
    """What the pass asked storage to join and remove (the `Joiner` seam), as gs:// URIs
    in a bucket of no consequence."""

    def __init__(self) -> None:
        self.joined: list[tuple[list[str], str, str]] = []
        self.removed: list[list[str]] = []

    async def join(self, keys: Sequence[str], into: str, content_type: str) -> str:
        self.joined.append((list(keys), into, content_type))
        return f"gs://bucket/{into}"

    async def remove(self, keys: Sequence[str]) -> None:
        self.removed.append(list(keys))


class Queued:
    """What the pass queued to be cut (the `Clips` seam)."""

    def __init__(self) -> None:
        self.clips: list[tuple[UUID, UUID, UUID]] = []

    async def add_clip(self, org_id: UUID, attempt_id: UUID, user_id: UUID) -> None:
        self.clips.append((org_id, attempt_id, user_id))


def recorded(
    org: UUID, user: UUID, plan_id: UUID, *, status: str = "done", slices: Sequence[int] = (0, 1)
) -> tuple[UUID, UUID]:
    """A session with one part (the back camera) of ten-second slices, uploaded at
    `slices`, and one attempt Director marked live; the session and the attempt."""
    session, marked = uuid4(), uuid4()
    with migrator() as db:
        db.execute(
            """INSERT INTO app.recording_session
                 (id, org_id, user_id, plan_id, video_id, shot_count, status, expires_at,
                  updated_at)
               VALUES (%s, %s, %s, %s, %s, 2, %s, now() + interval '1 day', now())""",
            (session, org, user, plan_id, VIDEO, status),
        )
        db.execute(
            """INSERT INTO app.recording_part (session_id, org_id, index, camera, content_type)
               VALUES (%s, %s, 0, 'back', 'video/webm')""",
            (session, org),
        )
        for index in slices:
            db.execute(
                """INSERT INTO app.recording_slice
                     (session_id, org_id, part_index, index, start_ms, duration_ms, size, status)
                   VALUES (%s, %s, 0, %s, %s, 10000, 100, 'uploaded')""",
                (session, org, index, index * 10_000),
            )
        db.execute(
            """INSERT INTO app.recording_attempt
                 (id, org_id, session_id, number, shot_index, part_index, start_ms, end_ms,
                  updated_at)
               VALUES (%s, %s, %s, 1, 0, 0, 2000, 6000, now())""",
            (marked, org, session),
        )
    return session, marked


def found(start_ms: int) -> NewAttempt:
    return NewAttempt(
        part=0,
        shot_index=1,
        start_ms=start_ms,
        end_ms=start_ms + 3_500,
        line="Morning. Coffee first.",
        score=80,
        reason="The cleanest delivery.",
        rehearsal=True,
    )


def test_a_finished_session_s_footage_is_joined_and_its_marks_read(client: TestClient) -> None:
    org, user = new_org()
    plan_id = insert_plan(org, VIDEO)
    session, marked = recorded(org, user, plan_id)
    joins, queued = Joins(), Queued()
    recordings = DbRecordings(joins, queued)

    footage = on_app_loop(client, lambda: recordings.footage(org, session))

    assert footage is not None
    assert footage.user_id == user
    assert len(footage.plan.shots) == 2
    into = f"recordings/{session}/0/whole"
    assert footage.parts == [PartFootage(0, "back", f"gs://bucket/{into}", "video/webm", 20_000)]
    assert joins.joined == [
        ([slice_key(session, 0, 0), slice_key(session, 0, 1)], into, "video/webm")
    ]
    [known] = footage.known
    assert (known.id, known.part, known.shot_index, known.start_ms, known.end_ms) == (
        marked,
        0,
        0,
        2_000,
        6_000,
    )

    # What the pass found: added once and queued once, however often it runs.
    on_app_loop(client, lambda: recordings.add(org, session, found(30_000)))
    on_app_loop(client, lambda: recordings.add(org, session, found(30_000)))
    [(queued_org, attempt, queued_user)] = queued.clips
    assert (queued_org, queued_user) == (org, user)
    with migrator() as db:
        row = db.execute(
            """SELECT number, shot_index, status, origin, reason, line
                 FROM app.recording_attempt WHERE id = %s""",
            (attempt,),
        ).fetchone()
    assert row == (2, 1, "clipping", "pass", "The cleanest delivery.", "Morning. Coffee first.")

    # Moved edges are only logged; the joined copy goes once the pass is done.
    refinement = Refinement(marked, 1_500, 6_500)
    on_app_loop(client, lambda: recordings.refine(org, session, refinement))
    on_app_loop(client, lambda: recordings.done(session))
    assert joins.removed == [[into]]
    on_app_loop(client, lambda: recordings.done(session))
    assert joins.removed == [[into]]


def test_a_session_with_nothing_to_go_through_has_no_footage(client: TestClient) -> None:
    org, user = new_org()
    plan_id = insert_plan(org, VIDEO)
    still_recording, _ = recorded(org, user, plan_id, status="recording")
    recordings = DbRecordings(Joins(), Queued())

    assert on_app_loop(client, lambda: recordings.footage(org, uuid4())) is None
    assert on_app_loop(client, lambda: recordings.footage(org, still_recording)) is None
    # Another workspace sees none of it.
    other, _ = new_org()
    assert on_app_loop(client, lambda: recordings.footage(other, still_recording)) is None
    # A plan still being written has no shots to go by.
    _ = as_org(
        org,
        "UPDATE ai.director_plan SET plan = NULL, status = 'analyzing' WHERE id = %s",
        (plan_id,),
    )
    unplanned, _ = recorded(org, user, plan_id)
    assert on_app_loop(client, lambda: recordings.footage(org, unplanned)) is None


# ------------------------------------------------------------------------------ storage


class _Compose(BaseModel):
    """What compose is sent: the objects joined, in order, and the joined one's type."""

    class _Source(BaseModel):
        name: str

    class _Destination(BaseModel):
        contentType: str

    sourceObjects: list[_Source]
    destination: _Destination


def _composed(name: str) -> tuple[str, Reply]:
    path = f"/storage/v1/b/{MEDIA_BUCKET}/o/{quote(name, safe='')}/compose?prettyPrint=false"
    return path, (200, {"bucket": MEDIA_BUCKET, "name": name, "generation": "1"})


def test_more_slices_than_one_compose_takes_are_joined_in_rounds() -> None:
    into = "recordings/s/0/whole"
    path, reply = _composed(into)
    keys = [f"recordings/s/0/{index}" for index in range(COMPOSE_MOST + 3)]
    with serve({path: lambda _body: reply}) as fake, pytest.MonkeyPatch.context() as patched:
        patched.setenv("STORAGE_EMULATOR_HOST", fake.url)
        joiner = GcsJoiner(MEDIA_BUCKET)
        uri = asyncio.run(joiner.join(keys, into, "video/webm"))
        asyncio.run(joiner.remove([into]))
    assert uri == f"gs://{MEDIA_BUCKET}/{into}"
    rounds = [_Compose.model_validate_json(body) for got, body in fake.received if got == path]
    # The first round joins as many as compose takes; the next, what's joined so far and
    # the rest.
    assert [[source.name for source in each.sourceObjects] for each in rounds] == [
        keys[:COMPOSE_MOST],
        [into, *keys[COMPOSE_MOST:]],
    ]
    assert {each.destination.contentType for each in rounds} == {"video/webm"}
    deleted = f"/storage/v1/b/{MEDIA_BUCKET}/o/{quote(into, safe='')}?prettyPrint=false"
    assert deleted in [got for got, _ in fake.received]


def test_an_attempt_the_pass_found_is_queued_to_be_cut_once_by_its_id(
    client: TestClient,
) -> None:
    assert client is not None
    org, user = new_org()
    attempt = uuid4()
    queue = ClipQueue(REDIS_URL)

    async def add_twice() -> None:
        await queue.add_clip(org, attempt, user)
        await queue.add_clip(org, attempt, user)
        await queue.close()

    asyncio.run(add_twice())
    job = stored_job(f"{{recording}}:recording:{attempt}")
    assert job[b"name"] == b"clip"
    assert _JSON.validate_json(job[b"data"]) == {
        "meta": {"orgId": str(org), "userId": str(user)},
        "payload": {"attemptId": str(attempt), "orgId": str(org)},
    }
