"""The post-session pass, through its seams: what's new and what moved (`reconcile`), the
job's run over a session (with stand-ins for the recording it reads and writes), and
Gemini watching the footage within the workspace's allowance."""

import asyncio
import os
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from pydantic_ai import VideoUrl
from pydantic_ai.models.test import TestModel
from redis.asyncio import Redis

from app.errors import AppError
from app.schemas import ShotPlan
from app.session_pass import (
    PASS_TOKENS,
    FoundAttempt,
    GeminiWatcher,
    KnownAttempt,
    NewAttempt,
    NoRecordings,
    PartFootage,
    Refinement,
    SessionFootage,
    SessionPass,
    pass_prompt,
    reconcile,
)
from app.session_recordings import (
    PartRow,
    SliceRow,
    StoredPart,
    create_session_pass,
    slice_key,
    stored_parts,
)
from app.settings import Settings
from app.usage import Reservation
from tests.test_eval_index_shorts import PLAN, SHOT

ORG = uuid4()
SESSION = uuid4()
MARKED = uuid4()
PLAN_TWO_SHOTS = ShotPlan.model_validate({**PLAN, "shots": [SHOT, SHOT]})
PARTS = (
    PartFootage(0, "front", "gs://bucket/recordings/s/0.webm", "video/webm", 60_000),
    PartFootage(1, "back", "gs://bucket/recordings/s/1.webm", "video/webm", 30_000),
)


def footage(*known: KnownAttempt) -> SessionFootage:
    return SessionFootage(user_id=uuid4(), plan=PLAN_TWO_SHOTS, parts=PARTS, known=known)


def found(
    start: float, end: float, *, part: int = 0, shot: int = 1, score: int = 80
) -> FoundAttempt:
    return FoundAttempt(
        part=part,
        shot=shot,
        startSeconds=start,
        endSeconds=end,
        line="Morning. Coffee first.",
        score=score,
        reason="The cleanest delivery.",
        rehearsal=True,
    )


def test_a_line_said_while_rehearsing_is_a_new_attempt() -> None:
    marked = KnownAttempt(MARKED, part=0, shot_index=0, start_ms=20_000, end_ms=24_000)
    new, moved = reconcile([found(5.0, 8.5)], footage(marked))
    assert new == [
        NewAttempt(
            part=0,
            shot_index=0,
            start_ms=5_000,
            end_ms=8_500,
            line="Morning. Coffee first.",
            score=80,
            reason="The cleanest delivery.",
            rehearsal=True,
        )
    ]
    assert moved == []


def test_a_marked_attempt_is_never_a_second_take_and_moves_only_when_its_edges_are_off() -> None:
    marked = KnownAttempt(MARKED, part=0, shot_index=0, start_ms=20_000, end_ms=24_000)
    # The same attempt, its edges within half a second: nothing to do.
    assert reconcile([found(20.2, 23.8)], footage(marked)) == ([], [])
    # The same attempt, starting a second earlier: cut again there.
    assert reconcile([found(19.0, 24.0)], footage(marked)) == (
        [],
        [Refinement(MARKED, 19_000, 24_000)],
    )
    # One that ran to its part's end is measured against that end.
    open_ended = KnownAttempt(MARKED, part=1, shot_index=1, start_ms=25_000, end_ms=None)
    assert reconcile([found(25.0, 29.0, part=1, shot=2)], footage(open_ended)) == (
        [],
        [Refinement(MARKED, 25_000, 29_000)],
    )
    # The same stretch on another part is another attempt.
    [new], _ = reconcile([found(20.0, 24.0, part=1)], footage(marked))
    assert new.part == 1


def test_overlapping_finds_keep_the_better_one_and_nonsense_is_dropped() -> None:
    new, _ = reconcile(
        [
            found(5.0, 9.0, score=60),
            found(5.5, 9.0, score=90),
            found(40.0, 44.0, shot=2),
            # Not a real part, not a real shot, too short.
            found(1.0, 3.0, part=7),
            found(1.0, 3.0, shot=3),
            found(50.0, 50.2),
        ],
        footage(),
    )
    assert [(a.start_ms, a.score, a.shot_index) for a in new] == [(5_500, 90, 0), (40_000, 80, 1)]
    # A stretch past its part's end, or longer than a shot may be, is cut to fit.
    [late], _ = reconcile([found(25.0, 40.0, part=1)], footage())
    assert (late.start_ms, late.end_ms) == (25_000, 30_000)
    [long], _ = reconcile([found(0.0, 59.9)], footage())
    assert long.end_ms - long.start_ms <= 60_000


def test_the_prompt_has_the_shots_the_marks_and_every_part_in_order() -> None:
    marked = KnownAttempt(MARKED, part=0, shot_index=0, start_ms=20_000, end_ms=24_000)
    running = KnownAttempt(uuid4(), part=1, shot_index=1, start_ms=1_500, end_ms=None)
    prompt = pass_prompt(footage(marked, running))
    texts = [item for item in prompt if isinstance(item, str)]
    assert texts[0].startswith("The shots:\n")
    assert "- part 0, shot 1: 20.0s to 24.0s" in texts[1]
    assert "- part 1, shot 2: 1.5s to the part's end" in texts[1]
    assert texts[2:] == ["Part 0 (front camera):", "Part 1 (back camera):"]
    videos = [item for item in prompt if isinstance(item, VideoUrl)]
    assert [video.url for video in videos] == [part.uri for part in PARTS]
    assert pass_prompt(footage())[1] == "The attempts you marked live:\n- none"


class Recording:
    """A session's recording as the seams see it, and what the pass did to it."""

    def __init__(self, footage: SessionFootage | None) -> None:
        self._footage = footage
        self.added: list[NewAttempt] = []
        self.refined: list[Refinement] = []
        self.finished = False

    async def footage(self, org_id: UUID, session_id: UUID) -> SessionFootage | None:
        return self._footage

    async def add(self, org_id: UUID, session_id: UUID, attempt: NewAttempt) -> None:
        self.added.append(attempt)

    async def refine(self, org_id: UUID, session_id: UUID, refinement: Refinement) -> None:
        self.refined.append(refinement)

    async def done(self, session_id: UUID) -> None:
        self.finished = True


class Watching:
    def __init__(self, answer: list[FoundAttempt] | AppError) -> None:
        self._answer = answer
        self.watched = 0

    async def watch(self, org_id: UUID, footage: SessionFootage) -> list[FoundAttempt]:
        self.watched += 1
        if isinstance(self._answer, AppError):
            raise self._answer
        return self._answer


class Changes:
    def __init__(self) -> None:
        self.orgs: list[UUID] = []

    async def __call__(self, org_id: UUID) -> None:
        self.orgs.append(org_id)


def test_the_pass_adds_what_the_marks_missed_and_re_cuts_what_moved() -> None:
    marked = KnownAttempt(MARKED, part=0, shot_index=0, start_ms=20_000, end_ms=24_000)
    recording = Recording(footage(marked))
    changes = Changes()
    watcher = Watching([found(5.0, 8.0), found(19.0, 24.0)])
    the_pass = SessionPass(watcher, recording, recording, changes)
    assert asyncio.run(the_pass.run(ORG, SESSION)) == (1, 1)
    assert [a.start_ms for a in recording.added] == [5_000]
    assert recording.refined == [Refinement(MARKED, 19_000, 24_000)]
    assert changes.orgs == [ORG]
    # What it made to watch the footage goes, however the pass ends.
    assert recording.finished


def test_the_pass_leaves_a_session_alone_when_there_s_nothing_to_do() -> None:
    changes = Changes()
    # No session, or no footage: nothing is watched.
    for nothing in (None, SessionFootage(uuid4(), PLAN_TWO_SHOTS, (), ())):
        watcher = Watching([])
        recording = Recording(nothing)
        assert asyncio.run(
            SessionPass(watcher, recording, recording, changes).run(ORG, SESSION)
        ) == (
            0,
            0,
        )
        assert watcher.watched == 0
    # Out of allowance: the live marks stand.
    recording = Recording(footage())
    broke = SessionPass(Watching(AppError("AI_BUDGET_EXCEEDED")), recording, recording, changes)
    assert asyncio.run(broke.run(ORG, SESSION)) == (0, 0)
    # Watched, and nothing new: no one is told.
    quiet = SessionPass(Watching([]), recording, recording, changes)
    assert asyncio.run(quiet.run(ORG, SESSION)) == (0, 0)
    assert changes.orgs == []


def test_without_a_recording_backend_the_pass_finds_no_session() -> None:
    stand_in = NoRecordings()
    assert asyncio.run(stand_in.footage(ORG, SESSION)) is None
    attempt = reconcile([found(5.0, 8.0)], footage())[0][0]
    with pytest.raises(RuntimeError):
        asyncio.run(stand_in.add(ORG, SESSION, attempt))
    with pytest.raises(RuntimeError):
        asyncio.run(stand_in.refine(ORG, SESSION, Refinement(MARKED, 0, 1_000)))


class Allowance:
    def __init__(self, tokens: int | None) -> None:
        self._tokens = tokens
        self.asked: list[int] = []
        self.settled: list[tuple[int, int]] = []

    async def reserve(self, org_id: UUID, user_id: UUID | None, most: int) -> Reservation | None:
        self.asked.append(most)
        if self._tokens is None:
            return None
        return Reservation(org_id, user_id, "director-pass", "gemini-test", self._tokens)

    async def settle(self, reservation: Reservation, input_tokens: int, output_tokens: int) -> None:
        self.settled.append((input_tokens, output_tokens))


def test_gemini_watches_within_the_allowance_and_settles_what_it_used() -> None:
    answer = found(5.0, 8.0).model_dump()
    allowance = Allowance(PASS_TOKENS)
    model = TestModel(custom_output_args={"attempts": [answer]})
    watcher = GeminiWatcher(model, allowance.reserve, allowance.settle)
    assert asyncio.run(watcher.watch(ORG, footage())) == [found(5.0, 8.0)]
    assert allowance.asked == [PASS_TOKENS]
    [(used_in, _)] = allowance.settled
    assert used_in > 0


def test_gemini_isn_t_asked_when_the_workspace_has_nothing_left() -> None:
    allowance = Allowance(None)
    watcher = GeminiWatcher(TestModel(), allowance.reserve, allowance.settle)
    with pytest.raises(AppError) as refused:
        asyncio.run(watcher.watch(ORG, footage()))
    assert refused.value.code == "AI_BUDGET_EXCEEDED"
    assert allowance.settled == []


def test_the_pass_is_on_with_director_and_reads_recordings_with_a_bucket() -> None:
    base = {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": "s" * 32,
    }
    director = {"DIRECTOR_MODEL": "gemini-test", "GOOGLE_API_KEY": "test-key"}
    redis = Redis()
    with patch.dict(os.environ, {}, clear=True):
        off = Settings.model_validate(base)
        on = Settings.model_validate({**base, **director})
        stored = Settings.model_validate({**base, **director, "MEDIA_BUCKET": "media-bucket"})
    assert create_session_pass(off, redis) is None
    for settings in (on, stored):
        passing = create_session_pass(settings, redis)
        assert passing is not None
        the_pass, clips = passing
        assert isinstance(the_pass, SessionPass)
        asyncio.run(clips.close())


def test_a_part_plays_from_its_first_slice_up_to_the_first_one_missing() -> None:

    parts = [
        PartRow(index=0, camera="front", content_type="video/webm"),
        PartRow(index=1, camera="back", content_type="video/mp4"),
        PartRow(index=2, camera="front", content_type="video/webm"),
    ]
    slices = [
        SliceRow(part_index=0, index=1, start_ms=10_000, duration_ms=10_000),
        SliceRow(part_index=0, index=0, start_ms=0, duration_ms=10_000),
        SliceRow(part_index=0, index=3, start_ms=30_000, duration_ms=10_000),
        # Part 1's first slice never arrived: none of it can be played.
        SliceRow(part_index=1, index=1, start_ms=10_000, duration_ms=4_000),
    ]
    assert stored_parts(parts, slices, SESSION) == [
        StoredPart(
            index=0,
            camera="front",
            content_type="video/webm",
            keys=[slice_key(SESSION, 0, 0), slice_key(SESSION, 0, 1)],
            duration_ms=20_000,
        )
    ]
    assert slice_key(SESSION, 2, 7) == f"recordings/{SESSION}/2/7"
