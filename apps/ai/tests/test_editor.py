"""The conversational editor's pure parts: what Gemini reads, and its answer as edits.
No database, Redis or model provider."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.db.models import DirectorTake
from app.editor import editor_context, ordered_takes, reply_of
from app.schemas import EditorDraft, EditorState, Shot
from tests.test_units import PLAN_DRAFT

SHOT_JSON = PLAN_DRAFT["shots"]
assert isinstance(SHOT_JSON, list)
SHOT = Shot.model_validate(SHOT_JSON[0])
START = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)

PARROT_INDEX: dict[str, object] = {
    "visible": "A person in a red cap with a green parrot on a perch behind them.",
    "things": ["green parrot", "red cap"],
    "transcript": [{"text": "Hi", "startSeconds": 0.4, "endSeconds": 0.7}],
    "moments": [{"kind": "smile", "atSeconds": 2.1, "note": "big smile"}],
    "quality": {"sharpness": "sharp", "shake": "steady", "exposure": "good", "audio": "clear"},
}


def take(shot_index: int, minutes: float, index: dict[str, object] | None = None) -> DirectorTake:
    return DirectorTake(
        id=uuid4(),
        org_id=uuid4(),
        plan_id=uuid4(),
        user_id=uuid4(),
        shot_index=shot_index,
        file_id=uuid4(),
        kind="video",
        status="ready",
        error=None,
        best_start_ms=500 if index else None,
        best_end_ms=3000 if index else None,
        score=80,
        feedback="Nice.",
        take_index=index,
        created_at=START + timedelta(minutes=minutes),
        updated_at=START,
    )


TAKES = [take(0, 2), take(0, 0, PARROT_INDEX), take(1, 3)]
STATE = EditorState.model_validate(
    {
        "shots": [
            {
                "shotIndex": 0,
                "takeId": str(TAKES[0].id),
                "startSeconds": 0,
                "endSeconds": 4,
                "position": 0,
                "grade": "none",
            },
            {
                "shotIndex": 1,
                "takeId": None,
                "startSeconds": 0,
                "endSeconds": 4,
                "position": None,
                "grade": "warm",
            },
        ],
        "captions": "pop",
        "sound": True,
        "music": False,
        "fixes": [{"text": "cloud", "replacement": "Claude"}],
    },
    strict=False,
)


def draft(**overrides: object) -> EditorDraft:
    action = {
        "op": "pick_take",
        "shot": 1,
        "take": 1,
        "otherShot": None,
        "position": None,
        "startSeconds": None,
        "endSeconds": None,
        "value": None,
        "level": None,
        "text": None,
        "replacement": None,
        "steps": None,
    }
    return EditorDraft.model_validate(
        {
            "heard": "the one with the parrot",
            "outcome": "applied",
            "say": "Swapped in your first try, the one with the parrot.",
            "actions": [action],
            "choices": [],
            **overrides,
        }
    )


def test_takes_are_numbered_oldest_first() -> None:
    assert [t.id for t in ordered_takes(TAKES, 0)] == [TAKES[1].id, TAKES[0].id]


def test_gemini_reads_every_take_with_its_index_and_the_edit() -> None:
    context = editor_context([SHOT, SHOT], TAKES, STATE)
    playing = '"playing": {"take": 2, "inOut": [0.0, 4.0], "place": 1, "grade": "none"}'
    assert playing in context
    assert '"filmed": "try 1, 0:00 in"' in context
    assert '"filmed": "try 2, 2:00 in"' in context
    assert '"things": ["green parrot", "red cap"]' in context
    assert '"keptSeconds": [0.5, 3.0]' in context
    assert '"index": null' in context
    assert '"playing": {"take": null, "inOut": [0.0, 4.0], "place": null, "grade": "warm"}' in (
        context
    )
    assert context.endswith(
        '{"captions": "pop", "voiceOn": true, "musicTrack": false,'
        ' "captionFixes": [{"text": "cloud", "replacement": "Claude"}]}'
    )


def test_an_applied_answer_names_shots_by_index_and_takes_by_id() -> None:
    reply = reply_of(draft(), 2, TAKES)
    assert reply.outcome == "applied"
    [action] = reply.actions
    assert (action.op, action.shotIndex, action.takeId) == ("pick_take", 0, TAKES[1].id)


def test_edits_that_name_nothing_real_are_dropped() -> None:
    base = draft().actions[0].model_dump()
    actions = [
        {**base, "take": 9},
        {**base, "shot": 5},
        {**base, "op": "trim", "shot": None},
        {**base, "op": "swap_shots", "shot": 1, "otherShot": 7},
        {**base, "op": "swap_shots", "shot": 1, "otherShot": 2, "take": None},
        {**base, "op": "move_shot", "shot": 2, "position": 1, "take": None},
        {**base, "op": "captions", "shot": None, "take": None, "value": "off"},
    ]
    reply = reply_of(draft(actions=actions), 2, TAKES)
    assert [(a.op, a.shotIndex, a.otherShotIndex, a.position) for a in reply.actions] == [
        ("swap_shots", 0, 1, None),
        ("move_shot", 1, None, 0),
        ("captions", None, None, None),
    ]


def test_nothing_changes_until_the_member_chooses() -> None:
    choices = [
        {"shot": 1, "take": 1, "atSeconds": 2.1, "note": "parrot on the left"},
        {"shot": 1, "take": 2, "atSeconds": 0.5, "note": "bird cushion"},
        {"shot": 2, "take": 4, "atSeconds": 0, "note": "not a take"},
    ]
    for outcome in ("ask", "no-match", "declined", "confirm", "answer"):
        reply = reply_of(draft(outcome=outcome, choices=choices), 2, TAKES)
        assert reply.actions == []
        assert [(c.shotIndex, c.takeId, c.note) for c in reply.choices] == [
            (0, TAKES[1].id, "parrot on the left"),
            (0, TAKES[0].id, "bird cushion"),
        ]
