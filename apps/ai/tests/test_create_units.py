"""Pure tests for app/create.py and app/storyboards.py: no model, database or queue."""

import re
import uuid
from datetime import UTC, datetime

from app.create import brief_prompt, new_video_id, questions_asked, retimed, storyboards_of
from app.db.models import DirectorAsset, DirectorPlan
from app.schemas import VIDEO_ID_PATTERN, BriefTurn, Shot, ShotPlan
from app.storyboards import storyboard_id, storyboard_prompt
from tests.test_plan_repair import shot


def a_plan(*shots: dict[str, object], edits: list[dict[str, object]] | None = None) -> ShotPlan:
    return ShotPlan.model_validate(
        {
            "title": "Morning coffee",
            "format": "Cosy routine",
            "summary": "My morning coffee. No talking, cosy.",
            "audio": "music",
            "durationSeconds": 20,
            "shots": list(shots),
            "edits": edits or [],
        }
    )


def test_a_created_plans_id_has_a_youtube_ids_shape_and_is_random() -> None:
    ids = {new_video_id() for _ in range(50)}
    assert len(ids) == 50
    assert all(re.fullmatch(VIDEO_ID_PATTERN, video_id) for video_id in ids)


def test_questions_count_directors_turns_only() -> None:
    turns = [
        BriefTurn(role="director", text="Cosy! Just you?"),
        BriefTurn(role="member", text="Just me"),
        BriefTurn(role="director", text="Talking or music?"),
    ]
    assert questions_asked(turns) == 2
    assert questions_asked([]) == 0


def test_the_brief_prompt_carries_the_idea_and_the_talk() -> None:
    assert brief_prompt("My coffee", []) == "What they want to make: My coffee"
    prompt = brief_prompt(
        "My coffee",
        [BriefTurn(role="director", text="Just you?"), BriefTurn(role="member", text="Yes")],
    )
    assert prompt.endswith("You (Director): Just you?\nThem: Yes")


def test_an_edited_plan_is_put_back_to_back_and_keeps_edits_inside_it() -> None:
    # The member moved the 6-second shot first and deleted one: the grade past the new
    # end goes, the captions are cut at it.
    edits: list[dict[str, object]] = [
        {"type": "grade", "startSeconds": 0, "endSeconds": 15, "grade": "warm", "target": "all"},
        {
            "type": "grade",
            "startSeconds": 12,
            "endSeconds": 14,
            "grade": "vivid",
            "target": "all",
        },
    ]
    plan = a_plan(
        shot(title="Pour", sourceStartSeconds=4, sourceEndSeconds=10, durationSeconds=6),
        shot(title="Sip", sourceStartSeconds=0, sourceEndSeconds=4, durationSeconds=4),
        edits=edits,
    )
    fixed = retimed(plan)
    assert [(s.title, s.sourceStartSeconds, s.sourceEndSeconds) for s in fixed.shots] == [
        ("Pour", 0, 6),
        ("Sip", 6, 10),
    ]
    assert fixed.durationSeconds == 10
    assert [(edit.startSeconds, edit.endSeconds) for edit in fixed.edits] == [(0, 10)]


def test_a_storyboard_follows_its_shot_and_changes_with_its_directions() -> None:
    first = Shot.model_validate(shot(scene="By your kitchen window"))
    same = Shot.model_validate(shot(scene="By your kitchen window", title="Renamed"))
    moved = Shot.model_validate(shot(scene="At the table"))
    assert storyboard_id(first) == storyboard_id(same)
    assert storyboard_id(first) != storyboard_id(moved)
    assert re.fullmatch(r"^[a-z0-9]+(-[a-z0-9]+)*$", storyboard_id(first))
    assert "By your kitchen window" in storyboard_prompt(first)
    assert "No text" in storyboard_prompt(first)


def _row(asset_id: str, status: str, key: str | None, error: str | None = None) -> DirectorAsset:
    return DirectorAsset(
        id=uuid.uuid4(),
        asset_id=asset_id,
        origin="storyboard",
        status=status,
        object_key=key,
        error=error,
    )


def test_cards_are_served_by_where_their_shots_are_now() -> None:
    window = shot(scene="By your window")
    table = shot(scene="At the table")
    plan = a_plan(table, window)
    row = DirectorPlan(
        id=uuid.uuid4(),
        source="created",
        plan=plan.model_dump(mode="json"),
        created_at=datetime.now(UTC),
    )
    window_card = storyboard_id(Shot.model_validate(window))
    cards = storyboards_of(
        row, [_row(window_card, "ready", "director-assets/p/a.png")], drawing=False
    )
    assert [(card.shotIndex, card.status, card.objectKey) for card in cards] == [
        (1, "ready", "director-assets/p/a.png")
    ]
    assert storyboards_of(DirectorPlan(plan=None), []) == []


def test_a_card_that_won_t_come_says_why() -> None:
    """A card that failed says why (the allowance used up), and one never claimed (past the
    day's images) reads as failed for that: the page tells the member rather than waiting
    on a drawing that isn't coming."""
    drawn, broke, never = shot(scene="By the window"), shot(scene="At the table"), shot()
    row = DirectorPlan(
        id=uuid.uuid4(),
        source="created",
        plan=a_plan(drawn, broke, never).model_dump(mode="json"),
        created_at=datetime.now(UTC),
    )
    cards = storyboards_of(
        row,
        [
            _row(storyboard_id(Shot.model_validate(drawn)), "pending", None),
            _row(storyboard_id(Shot.model_validate(broke)), "failed", None, "AI_BUDGET_EXCEEDED"),
        ],
    )
    assert [(card.shotIndex, card.status, card.error) for card in cards] == [
        (0, "pending", None),
        (1, "failed", "AI_BUDGET_EXCEEDED"),
        (2, "failed", "DIRECTOR_IMAGE_LIMIT"),
    ]
