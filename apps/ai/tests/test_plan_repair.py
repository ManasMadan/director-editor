"""Pure tests for app/plan_repair.py: no model, database or queue involved.

Gemini's plan passes schema validation field by field (each one within its own range),
but nothing ties a script line or a step to its shot's actual duration, or one shot's
source range to the next: `repair_plan` is what catches that instead of failing the
whole analysis.
"""

import pytest

from app.plan_repair import repair_plan
from app.schemas import (
    MAX_POSE_KEYPOINTS,
    MAX_SCRIPT_LINES,
    MAX_SHORT_SECONDS,
    MAX_SHOT_STEPS,
    MAX_SHOTS,
    ShotPlan,
)

# Keypoint.name's 13 allowed values (app/schemas.py's KeypointName); a test pose with
# more keypoints than that cycles back through them (the schema never requires unique
# names).
KEYPOINT_NAMES = (
    "nose",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)

FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
ANGLE: dict[str, object] = {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"}
POSE: dict[str, object] = {"description": "Standing, arms relaxed.", "keypoints": []}


def shot(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "kind": "video",
        "title": "A shot",
        "purpose": "Shows something.",
        "sourceStartSeconds": 0,
        "sourceEndSeconds": 4,
        "durationSeconds": 4,
        "camera": "back",
        "scene": "Anywhere with light",
        "sceneLandmark": None,
        "framing": FRAMING,
        "phoneAngle": ANGLE,
        "pose": POSE,
        "steps": [{"atSeconds": 0, "instruction": "Do it.", "cameraMove": "static"}],
        "script": [],
    }
    return {**base, **overrides}


def plan(*shots: dict[str, object], duration: float = 10) -> ShotPlan:
    return ShotPlan.model_validate(
        {
            "title": "A plan",
            "format": "GRWM",
            "summary": "A summary.",
            "audio": "none",
            "durationSeconds": duration,
            "shots": list(shots),
        }
    )


def test_repair_sorts_and_removes_overlaps() -> None:
    # B comes first in the source but second in the list, and overlaps A by a second.
    a = shot(title="A", sourceStartSeconds=5, sourceEndSeconds=9, durationSeconds=4)
    b = shot(title="B", sourceStartSeconds=0, sourceEndSeconds=6, durationSeconds=6)
    repaired = repair_plan(plan(a, b, duration=10), video_seconds=20)

    assert [s.title for s in repaired.shots] == ["B", "A"]
    first, second = repaired.shots
    assert (first.sourceStartSeconds, first.sourceEndSeconds) == (0, 5)
    assert (second.sourceStartSeconds, second.sourceEndSeconds) == (5, 9)


def test_repair_clamps_script_into_shot() -> None:
    # One line overruns the shot's duration and is pulled back in; the other starts and
    # ends entirely after it, and clamping would leave it empty, so it's dropped.
    overrunning = {"startSeconds": 3, "endSeconds": 8, "text": "Runs past the shot."}
    outside = {"startSeconds": 6, "endSeconds": 7, "text": "Never happens in this cut."}
    a_shot = shot(durationSeconds=5, script=[overrunning, outside])
    repaired = repair_plan(plan(a_shot, duration=5), video_seconds=20)

    [only] = repaired.shots
    assert [line.text for line in only.script] == ["Runs past the shot."]
    [line] = only.script
    assert (line.startSeconds, line.endSeconds) == (3, 5)


def test_repair_keeps_a_valid_plan_unchanged() -> None:
    a = shot(title="A", sourceStartSeconds=0, sourceEndSeconds=4, durationSeconds=4)
    b = shot(title="B", sourceStartSeconds=4, sourceEndSeconds=8, durationSeconds=4)
    original = plan(a, b, duration=8)

    repaired = repair_plan(original, video_seconds=20)

    assert repaired.model_dump() == original.model_dump()


def test_repair_drops_slivers_but_keeps_one_shot() -> None:
    # Both shots are already under the 0.3s floor before any overlap removal; dropping
    # every sliver would leave an empty plan (ShotPlan requires at least one shot), so the
    # longer of the two survives instead.
    tiny = shot(title="tiny", sourceStartSeconds=0, sourceEndSeconds=0.1, durationSeconds=0.5)
    tinier = shot(
        title="tinier", sourceStartSeconds=0.2, sourceEndSeconds=0.25, durationSeconds=0.5
    )
    repaired = repair_plan(plan(tiny, tinier, duration=1), video_seconds=20)

    assert [s.title for s in repaired.shots] == ["tiny"]


def test_repair_clamps_source_ranges_into_the_video() -> None:
    too_long = shot(sourceStartSeconds=90, sourceEndSeconds=95, durationSeconds=4)
    repaired = repair_plan(plan(too_long, duration=4), video_seconds=92)

    [only] = repaired.shots
    assert (only.sourceStartSeconds, only.sourceEndSeconds) == (90, 92)


def test_repair_without_a_video_length_clamps_to_the_short_s_own_limit() -> None:
    too_long = shot(
        sourceStartSeconds=MAX_SHORT_SECONDS - 5,
        sourceEndSeconds=MAX_SHORT_SECONDS,
        durationSeconds=4,
    )
    repaired = repair_plan(plan(too_long, duration=4), video_seconds=None)

    [only] = repaired.shots
    assert only.sourceEndSeconds == MAX_SHORT_SECONDS


def test_repair_clamps_a_step_into_its_shot() -> None:
    # atSeconds is valid on its own (within MAX_SHOT_SECONDS) but past this shot's
    # own, much shorter, edited duration.
    a_shot = shot(
        durationSeconds=5,
        steps=[
            {"atSeconds": 50, "instruction": "Long after the shot ends.", "cameraMove": "static"}
        ],
    )
    repaired = repair_plan(plan(a_shot, duration=5), video_seconds=200)

    [only] = repaired.shots
    [step] = only.steps
    assert step.atSeconds == 5


def test_repair_recomputes_the_plan_s_duration() -> None:
    a = shot(title="A", sourceStartSeconds=0, sourceEndSeconds=4, durationSeconds=4)
    b = shot(title="B", sourceStartSeconds=4, sourceEndSeconds=8, durationSeconds=4)
    # The plan claims 100 seconds; the two shots only add up to 8.
    repaired = repair_plan(plan(a, b, duration=100), video_seconds=20)

    assert repaired.durationSeconds == 8


def test_repair_trims_shots_to_the_director_max() -> None:
    # One second each, back to back: more than MAX_SHOTS of them, none a sliver, none
    # overlapping, so nothing but the trim itself drops any.
    extra = 3
    shots = [
        shot(title=str(i), sourceStartSeconds=i, sourceEndSeconds=i + 1, durationSeconds=1)
        for i in range(MAX_SHOTS + extra)
    ]
    repaired = repair_plan(plan(*shots, duration=len(shots)), video_seconds=len(shots))

    assert [s.title for s in repaired.shots] == [str(i) for i in range(MAX_SHOTS)]


def test_repair_trims_steps_and_script_and_keypoints() -> None:
    steps = [
        {"atSeconds": i, "instruction": f"Step {i}.", "cameraMove": "static"}
        for i in range(MAX_SHOT_STEPS + 5)
    ]
    script = [
        {"startSeconds": i * 0.2, "endSeconds": i * 0.2 + 0.15, "text": f"Line {i}."}
        for i in range(MAX_SCRIPT_LINES + 5)
    ]
    keypoints = [
        {"name": KEYPOINT_NAMES[i % len(KEYPOINT_NAMES)], "x": 0.5, "y": 0.5}
        for i in range(MAX_POSE_KEYPOINTS + 5)
    ]
    a_shot = shot(
        durationSeconds=60,
        sourceEndSeconds=60,
        steps=steps,
        script=script,
        pose={"description": "A pose.", "keypoints": keypoints},
    )
    repaired = repair_plan(plan(a_shot, duration=60), video_seconds=60)

    [only] = repaired.shots
    assert len(only.steps) == MAX_SHOT_STEPS
    assert [step.instruction for step in only.steps] == [
        f"Step {i}." for i in range(MAX_SHOT_STEPS)
    ]
    assert len(only.script) == MAX_SCRIPT_LINES
    assert len(only.pose.keypoints) == MAX_POSE_KEYPOINTS


def test_repair_synthesizes_a_step_when_the_shot_has_none() -> None:
    a_shot = shot(scene="Stand near a tree", steps=[])
    repaired = repair_plan(plan(a_shot, duration=4), video_seconds=20)

    [only] = repaired.shots
    [step] = only.steps
    assert step.atSeconds == 0
    assert step.cameraMove == "static"
    assert "Stand near a tree" in step.instruction


def test_repair_raises_for_a_plan_with_no_shots() -> None:
    with pytest.raises(ValueError, match="at least one shot"):
        repair_plan(plan(duration=4), video_seconds=20)
