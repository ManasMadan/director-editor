"""Re-planning the member's version (app/revise.py): Gemini's draft over their version."""

from app.revise import apply_revision, revise_prompt
from app.schemas import (
    RevisedShotDraft,
    ReviseRequest,
    RevisionDraft,
    ShotPlan,
    ShotVersion,
    YourVersion,
)
from tests.test_director import PLAN

SHOTS = ShotPlan.model_validate(PLAN)


def draft_shot(shot: int, status: str = "film", **rows: str | None) -> RevisedShotDraft:
    fields: dict[str, object] = {
        "shot": shot,
        "status": status,
        "where": None,
        "action": None,
        "line": None,
        "framing": None,
        "camera": None,
    }
    return RevisedShotDraft.model_validate({**fields, **rows})


def version(**fields: object) -> YourVersion:
    empty: dict[str, object] = {"notes": [], "shots": [], "skipped": [], "gaps": []}
    return YourVersion.model_validate({**empty, **fields})


def test_the_draft_s_statuses_and_changes_go_over_their_version() -> None:
    before = version(
        notes=[{"kind": "place", "note": "Inside"}],
        shots=[{"shot": 0, "where": "By the window", "line": "Hi"}],
        skipped=[1],
    )
    draft = RevisionDraft(
        shots=[
            draft_shot(1, where="  Right here  ", line=" ", camera="front"),
            draft_shot(2, "gap"),
            draft_shot(9, "skip"),
        ],
        summary="  Everything's from right here now.  ",
    )
    result = apply_revision(SHOTS, before, draft)
    assert result.version == version(
        notes=[{"kind": "place", "note": "Inside"}],
        shots=[{"shot": 0, "where": "Right here", "line": "Hi", "camera": "front"}],
        gaps=[1],
    )
    assert result.summary == "Everything's from right here now."


def test_a_shot_the_draft_leaves_alone_keeps_what_it_had() -> None:
    before = version(shots=[{"shot": 1, "action": "Wave"}], gaps=[0], skipped=[7])
    result = apply_revision(SHOTS, before, RevisionDraft(shots=[], summary="x" * 400))
    assert result.version.shots == [ShotVersion(shot=1, action="Wave")]
    assert result.version.gaps == [0]
    # A shot past the plan is dropped.
    assert result.version.skipped == []
    assert len(result.summary) == 300


def test_a_skipped_shot_with_nothing_changed_has_no_entry() -> None:
    result = apply_revision(
        SHOTS, version(), RevisionDraft(shots=[draft_shot(1, "skip")], summary="")
    )
    assert result.version == version(skipped=[0])


def test_the_prompt_names_the_shots_their_version_and_the_instruction() -> None:
    request = ReviseRequest(
        instruction="one angle",
        version=version(notes=[{"kind": "angles", "note": "One angle"}], gaps=[1]),
    )
    prompt = "\n".join(revise_prompt(SHOTS, request))
    for part in ["1. The top", "2. The full look", '"gaps":[1]', "angles: One angle", "one angle"]:
        assert part in prompt, part
    bare = "\n".join(revise_prompt(SHOTS, ReviseRequest(instruction="x", version=version())))
    assert "(nothing yet)" in bare
