"""Pure tests for scripts/build_seeds.py: no network, no Gemini call. The script lives
outside app/ (apps/ai/pyproject.toml's `[tool.coverage.run]` only measures `app`), so
these tests aren't what keeps apps/ai at 100% coverage, but its non-network logic
(assembling an entry, validating it, writing the file) is tested here the same as
anything else, with the Gemini call injected instead of a real one: there is no local
stand-in for indexing a short (CLAUDE.md's "no fakes outside tests" cuts the other way
here -- a unit test is exactly where a real Vertex AI call doesn't belong).
"""

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas import ShotPlan
from scripts.build_seeds import (
    SeedSource,
    SeedTemplate,
    audio_key,
    build_entry,
    build_templates,
    load_seeds,
    write_templates,
)

FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
ANGLE: dict[str, object] = {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"}
POSE: dict[str, object] = {"description": "Standing, arms relaxed.", "keypoints": []}


def shot_plan(video_id: str = "22k0fZarxh8") -> ShotPlan:
    return ShotPlan.model_validate(
        {
            "title": "A plan",
            "format": "GRWM",
            "summary": "A summary.",
            "audio": "none",
            "durationSeconds": 4,
            "shots": [
                {
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
            ],
        }
    )


def test_audio_key_is_the_seed_audio_already_uploaded_for_the_video() -> None:
    # The 6 seeds' original audio is already in gs://director-media-1053522546520 under
    # this key; build_seeds doesn't fetch it (task-2.2.5-brief.md), only records it.
    assert audio_key("22k0fZarxh8") == "seed-audio/22k0fZarxh8.m4a"


def test_load_seeds_reads_the_real_seeds_json() -> None:
    seeds = load_seeds()
    assert len(seeds) == 6
    assert all(isinstance(seed, SeedSource) for seed in seeds)


def test_seed_source_ignores_its_other_fields() -> None:
    """Only videoId matters to the script; title/channel/kind (seeds.json's other
    columns, for a human picking a seed) never refuse the row."""
    seed = SeedSource.model_validate(
        {"videoId": "22k0fZarxh8", "title": "T", "channel": "C", "kind": "dance"}
    )
    assert seed.videoId == "22k0fZarxh8"


def test_load_seeds_refuses_a_malformed_video_id(tmp_path: Path) -> None:
    bad = tmp_path / "seeds.json"
    bad.write_text(json.dumps([{"videoId": "not-a-video-id"}]))
    with pytest.raises(ValidationError):
        load_seeds(bad)


async def test_build_entry_indexes_the_seed_and_records_its_audio_key() -> None:
    plan = shot_plan()

    async def index(video_id: str) -> tuple[ShotPlan, str]:
        assert video_id == "22k0fZarxh8"
        return plan, "gemini-4-argon"

    entry = await build_entry(SeedSource(videoId="22k0fZarxh8"), index)

    assert entry == SeedTemplate(
        videoId="22k0fZarxh8",
        plan=plan,
        model="gemini-4-argon",
        audioKey="seed-audio/22k0fZarxh8.m4a",
    )


async def test_build_templates_indexes_every_seed_in_order() -> None:
    seeds = [SeedSource(videoId="22k0fZarxh8"), SeedSource(videoId="152Jy2c3XSM")]
    seen: list[str] = []

    async def index(video_id: str) -> tuple[ShotPlan, str]:
        seen.append(video_id)
        return shot_plan(video_id), "gemini-4-argon"

    templates = await build_templates(seeds, index)

    assert seen == ["22k0fZarxh8", "152Jy2c3XSM"]
    assert [template.videoId for template in templates] == seen
    assert all(template.model == "gemini-4-argon" for template in templates)


async def test_build_templates_lets_a_failed_seed_s_error_propagate() -> None:
    """A seed Gemini can't index at all (after the retry and the fallback both fail)
    stops the whole run rather than writing a templates.json missing one of the 6: every
    seed must end up in it (task-2.2.5-brief.md)."""
    seeds = [SeedSource(videoId="22k0fZarxh8")]

    async def index(video_id: str) -> tuple[ShotPlan, str]:
        raise RuntimeError(f"Gemini gave up on {video_id}")

    with pytest.raises(RuntimeError, match="22k0fZarxh8"):
        _ = await build_templates(seeds, index)


def test_write_templates_round_trips_through_json(tmp_path: Path) -> None:
    path = tmp_path / "templates.json"
    templates = [
        SeedTemplate(
            videoId="22k0fZarxh8",
            plan=shot_plan(),
            model="gemini-4-argon",
            audioKey="seed-audio/22k0fZarxh8.m4a",
        )
    ]

    write_templates(templates, path)

    written = TypeAdapter(list[SeedTemplate]).validate_json(path.read_text())
    assert [entry.videoId for entry in written] == ["22k0fZarxh8"]
    [loaded] = written
    assert loaded == templates[0]
    # A trailing newline: the file ends like every other committed JSON file in the repo.
    assert path.read_text().endswith("\n")


def test_seed_template_refuses_a_plan_with_no_shots() -> None:
    # ShotPlan.shots itself enforces min_length=1 (app/schemas.py); SeedTemplate just
    # carries that through, which is what lets this test stand in for "every seed's plan
    # has at least one shot" without touching the committed templates.json.
    with pytest.raises(ValidationError):
        ShotPlan.model_validate(
            {
                "title": "A plan",
                "format": "GRWM",
                "summary": "A summary.",
                "audio": "none",
                "durationSeconds": 4,
                "shots": [],
            }
        )
