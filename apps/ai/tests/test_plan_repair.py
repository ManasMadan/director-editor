"""Pure tests for app/plan_repair.py: no model, database or queue involved.

Gemini's plan passes schema validation field by field (each one within its own range),
but nothing ties a script line or a step to its shot's actual duration, or one shot's
source range to the next: `repair_plan` is what catches that instead of failing the
whole analysis.
"""

import random

import pytest

from app.plan_repair import repair_plan
from app.schemas import (
    MAX_POSE_KEYPOINTS,
    MAX_SCRIPT_LINES,
    MAX_SHORT_SECONDS,
    MAX_SHOT_SECONDS,
    MAX_SHOT_STEPS,
    MAX_SHOTS,
    ShotPlanDraft,
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
        "mode": "on-camera",
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


def plan(*shots: dict[str, object], duration: float = 10) -> ShotPlanDraft:
    # The draft Gemini answers with: no length bound on `shots` (or, inside each shot, on
    # `steps`, `script` or `pose.keypoints`), unlike the real `ShotPlan` repair_plan
    # returns. See app/schemas.py's module comment.
    return ShotPlanDraft.model_validate(
        {
            "title": "A plan",
            "format": "GRWM",
            "summary": "A summary.",
            "audio": "none",
            "durationSeconds": duration,
            "shots": list(shots),
            "assets": [],
            "edits": [],
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


def test_repair_trims_shots_to_the_director_max_but_keeps_the_last() -> None:
    # One second each, back to back: more than MAX_SHOTS of them, none a sliver, none
    # overlapping, so nothing but the trim itself drops any. Cutting the tail would drop
    # the payoff (the last shot), so the trim keeps the earliest MAX_SHOTS - 1 plus it.
    extra = 3
    shots = [
        shot(title=str(i), sourceStartSeconds=i, sourceEndSeconds=i + 1, durationSeconds=1)
        for i in range(MAX_SHOTS + extra)
    ]
    repaired = repair_plan(plan(*shots, duration=len(shots)), video_seconds=len(shots))

    last = MAX_SHOTS + extra - 1
    assert [s.title for s in repaired.shots] == [
        *(str(i) for i in range(MAX_SHOTS - 1)),
        str(last),
    ]


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
    # The scene text alone, not a hard-coded English phrase wrapped around it: the scene
    # is already in the short's own language.
    a_shot = shot(scene="Stand near a tree", steps=[])
    repaired = repair_plan(plan(a_shot, duration=4), video_seconds=20)

    [only] = repaired.shots
    [step] = only.steps
    assert step.atSeconds == 0
    assert step.cameraMove == "static"
    assert step.instruction == "Stand near a tree"


def test_repair_raises_for_a_plan_with_no_shots() -> None:
    with pytest.raises(ValueError, match="at least one shot"):
        repair_plan(plan(duration=4), video_seconds=20)


def _shot_with_edge_content(index: int, duration: float = 20) -> dict[str, object]:
    """A shot whose step and script line sit near the end of its original duration, so
    scaling that duration down has to pull them in, not just leave them be. Its source
    range is a short, non-overlapping slice (independent of the edited duration, which
    can run longer than the source it's cut from, e.g. slow motion) so many of these fit
    within MAX_SHORT_SECONDS regardless of how long each one is edited to run."""
    source_start = index * 2
    return shot(
        title=str(index),
        sourceStartSeconds=source_start,
        sourceEndSeconds=source_start + 1,
        durationSeconds=duration,
        steps=[
            {"atSeconds": 0, "instruction": "Start.", "cameraMove": "static"},
            {"atSeconds": duration - 2, "instruction": "Near the end.", "cameraMove": "static"},
        ],
        script=[
            {"startSeconds": duration - 10, "endSeconds": duration - 1, "text": "Near the end."}
        ],
    )


def test_repair_scales_durations_down_to_fit_the_short_when_video_length_is_unknown() -> None:
    # 12 shots of 20s each: 240s of edited footage, more than a short can ever be
    # (MAX_SHORT_SECONDS, the ceiling used when video_seconds isn't known). Every shot
    # scales down by the same factor (180 / 240 = 0.75, to 15s each), keeping their equal
    # pacing; their steps and script lines, timed against the original 20s, land inside
    # the new 15s instead of past it.
    shots = [_shot_with_edge_content(i) for i in range(MAX_SHOTS)]
    repaired = repair_plan(plan(*shots, duration=100), video_seconds=None)

    assert repaired.durationSeconds <= MAX_SHORT_SECONDS
    durations = [s.durationSeconds for s in repaired.shots]
    assert durations == pytest.approx([15.0] * MAX_SHOTS)  # all scaled by the same factor
    for s in repaired.shots:
        assert len(s.steps) == 2  # neither clamped away, just pulled inside
        assert len(s.script) == 1
        for step in s.steps:
            assert step.atSeconds <= s.durationSeconds
        for line in s.script:
            assert line.endSeconds <= s.durationSeconds


def test_repair_scales_durations_down_further_to_fit_a_shorter_video() -> None:
    # The same over-long draft, but this short is only 30s long: the shots scale down
    # more (180 / 240 would be too generous; 30 / 240 = 0.125, to 2.5s each) to fit it.
    shots = [_shot_with_edge_content(i) for i in range(MAX_SHOTS)]
    repaired = repair_plan(plan(*shots, duration=100), video_seconds=30)

    assert repaired.durationSeconds <= 30
    durations = [s.durationSeconds for s in repaired.shots]
    assert durations == pytest.approx([2.5] * MAX_SHOTS)


def test_repair_leaves_durations_unchanged_when_already_under_the_ceiling() -> None:
    a = shot(title="A", sourceStartSeconds=0, sourceEndSeconds=4, durationSeconds=4)
    b = shot(title="B", sourceStartSeconds=4, sourceEndSeconds=8, durationSeconds=4)
    repaired = repair_plan(plan(a, b, duration=8), video_seconds=20)

    assert [s.durationSeconds for s in repaired.shots] == [4, 4]


def _shots_with_durations(durations: list[float]) -> list[dict[str, object]]:
    """Shots whose source ranges are short, valid and non-overlapping, regardless of the
    (possibly much longer) edited durations given."""
    return [
        shot(
            title=str(i),
            sourceStartSeconds=i * 2,
            sourceEndSeconds=i * 2 + 1,
            durationSeconds=duration,
        )
        for i, duration in enumerate(durations)
    ]


def test_repair_scaled_durations_stay_at_or_under_the_ceiling_a_known_overshoot() -> None:
    # Found with a small seeded search (random.Random(5): 2-12 shots, durations uniform
    # in [0.5, 60], ceiling 180) for a set whose plain floating-point scaling
    # (`d * (ceiling / total)`) summed to 180.00000000000003 — a hair over
    # MAX_SHORT_SECONDS, which ShotPlan.durationSeconds's own le=180 refused.
    durations = [
        15.698978480967325,
        21.832862949475768,
        41.58158732262098,
        50.569902386694885,
        39.29588595687104,
        32.037371346546784,
        50.50071317109874,
        46.66953476242516,
        15.318633035674585,
        3.5852685950963106,
        9.832653676984863,
    ]
    repaired = repair_plan(
        plan(*_shots_with_durations(durations), duration=100), video_seconds=None
    )

    assert repaired.durationSeconds <= MAX_SHORT_SECONDS


def test_repair_scaled_durations_never_exceed_the_ceiling_fuzzed() -> None:
    # The same shape of search that found the case above (2-12 shots, durations uniform
    # in [0.5, 60]), run broadly instead of to a single failure: many of these 1,000 need
    # scaling (durations average 30.25, so most draws of a few shots already exceed
    # MAX_SHORT_SECONDS), exercising the scale-and-floor path on a wide spread of
    # floating-point sums rather than depending on any single one of them to misround.
    rng = random.Random(0)  # noqa: S311 (a deterministic fuzz seed, not a secret)
    for _ in range(1_000):
        count = rng.randint(2, MAX_SHOTS)
        durations = [rng.uniform(0.5, MAX_SHOT_SECONDS) for _ in range(count)]
        repaired = repair_plan(
            plan(*_shots_with_durations(durations), duration=100), video_seconds=None
        )
        assert repaired.durationSeconds <= MAX_SHORT_SECONDS


# Comfortably over MIN_SHOT_SOURCE_SECONDS (0.3): spacing shots exactly 0.3 apart hits
# float imprecision (0.6 - 0.3 can come out a hair under 0.3), which _drop_slivers would
# then read as one sliver too many and drop. This margin is far bigger than that ever is.
_SAFE_SOURCE_SPAN = 0.31


def test_repair_floors_both_shots_when_they_overflow_the_floor_together() -> None:
    # Two shots whose source spans just fit a very short video (back to back, each a
    # hair over MIN_SHOT_SOURCE_SECONDS so neither is dropped as a sliver): both original
    # durations overflow the 0.5s floor at the same scale, so both get pinned to it in
    # the same pass.
    shots = [
        shot(
            title="A", sourceStartSeconds=0, sourceEndSeconds=_SAFE_SOURCE_SPAN, durationSeconds=1
        ),
        shot(
            title="B",
            sourceStartSeconds=_SAFE_SOURCE_SPAN,
            sourceEndSeconds=2 * _SAFE_SOURCE_SPAN,
            durationSeconds=1,
        ),
    ]
    repaired = repair_plan(plan(*shots, duration=2), video_seconds=0.9)

    assert [s.durationSeconds for s in repaired.shots] == [0.5, 0.5]


def test_repair_floors_every_shot_when_they_still_dont_fit_even_at_the_floor() -> None:
    # Found with the same kind of seeded search as the others above (random.Random(1):
    # 12 durations uniform in [0.5, 60], a ceiling uniform in [3.6, 6) -- short enough
    # that 12 shots can still each keep their own slice of it, long enough that scaling
    # wouldn't usually need every shot at the floor): these durations, scaled down in
    # rounds, end up with all 12 pinned to the 0.5s floor -- 6s of edited footage for a
    # video only 3.92s long. repair_plan still returns a valid plan: that 6s is still
    # under MAX_SHORT_SECONDS (180), the hard bound on ShotPlan.durationSeconds; it's
    # only the short's own, shorter ceiling this one can't quite fit under.
    ceiling = 3.922474185869763
    durations = [
        50.92230734776535,
        45.94458982910854,
        15.67660703149559,
        29.978387681970485,
        27.24471835492992,
        39.2697818770044,
        47.429039392563034,
        6.084645413066976,
        2.186674853059375,
        50.228023683232244,
        26.249640540350676,
        45.85566490624755,
    ]
    shots = [
        shot(
            title=str(i),
            sourceStartSeconds=i * _SAFE_SOURCE_SPAN,
            sourceEndSeconds=(i + 1) * _SAFE_SOURCE_SPAN,
            durationSeconds=duration,
        )
        for i, duration in enumerate(durations)
    ]
    repaired = repair_plan(plan(*shots, duration=100), video_seconds=ceiling)

    assert [s.durationSeconds for s in repaired.shots] == [0.5] * 12
    assert repaired.durationSeconds <= MAX_SHORT_SECONDS
    # The one case the scaling can't fix: every shot pinned at the floor still adds up
    # to more than this particular video's own ceiling (not MAX_SHORT_SECONDS).
    assert repaired.durationSeconds > ceiling
