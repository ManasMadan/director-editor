"""The shot as the member's version has it (app/your_version.py), as the contract's
applyShotVersion (packages/contracts src/api/your-version.ts) gives it."""

from app.schemas import ShotPlan, ShotVersion, YourVersion
from app.your_version import apply_shot_version, shot_version, told
from tests.test_director import PLAN

[FIRST, SECOND] = ShotPlan.model_validate(PLAN).shots[:2]


def test_no_version_is_the_original() -> None:
    assert apply_shot_version(FIRST, None) == FIRST


def test_the_version_replaces_the_place_title_action_line_framing_and_camera() -> None:
    shot = apply_shot_version(
        FIRST,
        ShotVersion(
            shot=0,
            title="Intro at your desk",
            where="At your desk",
            action="Wave at the camera",
            line="Hi, it's me",
            framing="Waist up",
            camera="front",
        ),
    )
    assert shot.title == "Intro at your desk"
    assert (shot.scene, shot.sceneLandmark) == ("At your desk", None)
    assert shot.steps[0].instruction == "Wave at the camera"
    assert shot.steps[1:] == FIRST.steps[1:]
    assert [(line.startSeconds, line.endSeconds, line.text) for line in shot.script] == [
        (0, FIRST.durationSeconds, "Hi, it's me")
    ]
    assert shot.framing.note == "Waist up"
    assert shot.framing.shotSize == FIRST.framing.shotSize
    assert shot.camera == "front"
    assert (shot.purpose, shot.pose) == (FIRST.purpose, FIRST.pose)


def test_a_version_that_leaves_things_alone_keeps_the_original_s() -> None:
    shot = apply_shot_version(FIRST, ShotVersion(shot=0, line="Hi"))
    assert (shot.title, shot.scene, shot.sceneLandmark) == (
        FIRST.title,
        FIRST.scene,
        FIRST.sceneLandmark,
    )
    assert (shot.steps, shot.framing, shot.camera) == (FIRST.steps, FIRST.framing, FIRST.camera)


def test_with_no_steps_the_action_is_the_pose() -> None:
    bare = SECOND.model_copy(update={"steps": []})
    shot = apply_shot_version(bare, ShotVersion(shot=1, action="Hold up the cup"))
    assert shot.pose.description == "Hold up the cup"
    assert shot.steps == []


def test_a_shot_s_version_and_what_they_told_director() -> None:
    version = YourVersion.model_validate(
        {
            "notes": [{"kind": "place", "note": "Inside"}],
            "shots": [{"shot": 1, "where": "Kitchen"}],
            "skipped": [],
            "gaps": [],
        }
    )
    assert shot_version(version, 1) == ShotVersion(shot=1, where="Kitchen")
    assert shot_version(version, 0) is None
    assert shot_version(None, 0) is None
    assert told(version) == ["- place: Inside"]
    assert told(None) == []
