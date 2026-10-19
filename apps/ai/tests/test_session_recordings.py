"""The post-session pass's way into a recording (app/session_recordings.py's
DbRecordings) against the real tables, as app_ai: what it reads of a finished session,
and the attempts it adds, once each however often the pass runs."""

from collections.abc import Sequence
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.session_pass import NewAttempt
from app.session_recordings import DbRecordings
from tests.support import as_org, new_org, on_app_loop
from tests.test_eval_index_shorts import PLAN

pytestmark = pytest.mark.integration

VIDEO = "dQw4w9WgXcQ"


class Joined:
    """Cloud Storage's compose, standing in: names the joined object, joins nothing."""

    def __init__(self) -> None:
        self.removed: list[str] = []

    async def join(self, keys: Sequence[str], into: str, content_type: str) -> str:
        return f"gs://bucket/{into}"

    async def remove(self, keys: Sequence[str]) -> None:
        self.removed.extend(keys)


class Queued:
    """The `recording` queue, standing in: what was queued to be cut."""

    def __init__(self) -> None:
        self.clips: list[UUID] = []

    async def add_clip(self, org_id: UUID, attempt_id: UUID, user_id: UUID) -> None:
        self.clips.append(attempt_id)


def done_session(org: UUID, user: UUID) -> UUID:
    """A finished session with one part of one uploaded slice, as apps/api leaves it."""
    [(plan_id,)] = as_org(
        org,
        """INSERT INTO ai.director_plan
             (org_id, created_by, video_id, source, status, stage, plan, model, updated_at)
           VALUES (%s, %s, %s, 'seed', 'ready', 'ready', %s, 'seed-model', now())
           RETURNING id""",
        (org, user, VIDEO, Jsonb(PLAN)),
    )
    [(session_id,)] = as_org(
        org,
        """INSERT INTO app.recording_session
             (org_id, user_id, plan_id, video_id, shot_count, status, expires_at, updated_at)
           VALUES (%s, %s, %s, %s, 2, 'done', now() + interval '1 day', now())
           RETURNING id""",
        (org, user, plan_id, VIDEO),
    )
    as_org(
        org,
        """INSERT INTO app.recording_part (session_id, org_id, index, camera, content_type)
           VALUES (%s, %s, 0, 'front', 'video/webm')""",
        (session_id, org),
    )
    as_org(
        org,
        """INSERT INTO app.recording_slice
             (session_id, org_id, part_index, index, start_ms, duration_ms, size, status)
           VALUES (%s, %s, 0, 0, 0, 10000, 1000, 'uploaded')""",
        (session_id, org),
    )
    assert isinstance(session_id, UUID)
    return session_id


def found(start_ms: int) -> NewAttempt:
    return NewAttempt(
        part=0,
        shot_index=1,
        start_ms=start_ms,
        end_ms=start_ms + 3_000,
        line="the line",
        score=80,
        reason="said it best here",
        rehearsal=True,
    )


def test_the_pass_adds_an_attempt_once_however_often_it_runs(client: TestClient) -> None:
    org, user = new_org()
    session_id = done_session(org, user)
    joined, queued = Joined(), Queued()
    recordings = DbRecordings(joined, queued)

    footage = on_app_loop(client, lambda: recordings.footage(org, session_id))
    assert footage is not None
    assert footage.parts[0].uri == f"gs://bucket/recordings/{session_id}/0/whole"
    on_app_loop(client, lambda: recordings.add(org, session_id, found(2_000)))
    # The pass run again (a retried job) finds the same attempt: it's added and queued once.
    on_app_loop(client, lambda: recordings.add(org, session_id, found(2_000)))
    on_app_loop(client, lambda: recordings.add(org, session_id, found(6_000)))

    rows = as_org(
        org,
        """SELECT number, start_ms, status, origin, reason FROM app.recording_attempt
           WHERE session_id = %s ORDER BY number""",
        (session_id,),
    )
    assert rows == [
        (1, 2_000, "clipping", "pass", "said it best here"),
        (2, 6_000, "clipping", "pass", "said it best here"),
    ]
    assert len(queued.clips) == 2
    on_app_loop(client, lambda: recordings.done(session_id))
    assert joined.removed == [f"recordings/{session_id}/0/whole"]


def test_an_attempt_the_pass_added_but_never_queued_is_queued_on_the_next_run(
    client: TestClient,
) -> None:
    """A run of the pass that added an attempt and then failed before queuing it (the
    queue unreachable a moment): the next run sees it among the known attempts, so it isn't
    added again, and it would never be cut. It's queued then; the queue's job id is the
    attempt's, so one queued already isn't cut twice."""
    org, user = new_org()
    session_id = done_session(org, user)
    attempts: dict[tuple[str, str], UUID] = {}
    for number, (status, origin) in enumerate(
        [("clipped", "shoot"), ("clipping", "pass"), ("clipped", "pass")], start=1
    ):
        [(attempt_id,)] = as_org(
            org,
            """INSERT INTO app.recording_attempt (org_id, session_id, number, shot_index,
                 part_index, start_ms, end_ms, status, origin, updated_at)
               VALUES (%s, %s, %s, 0, 0, %s, %s, %s, %s, now()) RETURNING id""",
            (org, session_id, number, number * 2_000, number * 2_000 + 1_500, status, origin),
        )
        assert isinstance(attempt_id, UUID)
        attempts[status, origin] = attempt_id
    queued = Queued()
    footage = on_app_loop(client, lambda: DbRecordings(Joined(), queued).footage(org, session_id))
    assert footage is not None
    assert len(footage.known) == 3
    assert queued.clips == [attempts["clipping", "pass"]]
