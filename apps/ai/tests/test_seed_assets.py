"""Tests for scripts/seed_assets.py: filling in the seeds' assets and edits from a new index
of each, with the index injected (no Gemini), on a temporary seed file; and the command
run as a module."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.plan_repair import repair_plan
from app.schemas import ShotPlan, ShotPlanDraft
from app.settings import Settings, get_settings
from scripts.build_seeds import APP_ROOT, Indexer, SeedTemplate, load_templates, write_templates
from scripts.seed_assets import USAGE_ERROR, fill_in, main
from tests.test_build_seeds import PLAN, PLAN_SHOT
from tests.test_plan_repair_assets import asset, edit
from tests.tokens import SECRET

VIDEO = "22k0fZarxh8"
OTHER = "152Jy2c3XSM"
AT = f"seed-media/{VIDEO}"


def seed(video_id: str = VIDEO) -> SeedTemplate:
    return SeedTemplate.model_validate(
        {
            "videoId": video_id,
            "plan": PLAN,
            "model": "gemini-4-argon",
            "audioKey": f"seed-audio/{video_id}.m4a",
        }
    )


# A new index of the Short: another cut of it (one long shot), the chart under the
# speaker, and an end card.
NEWER = repair_plan(
    ShotPlanDraft.model_validate(
        {
            **PLAN,
            "shots": [{**PLAN_SHOT, "sourceEndSeconds": 9, "durationSeconds": 9}],
            "assets": [asset(id="chart"), asset(id="end card", kind="end-card")],
            "edits": [edit("layout", layout="split", assetId="chart")],
        }
    ),
    None,
)


def indexes(plan: ShotPlan = NEWER) -> tuple[Indexer, list[str]]:
    asked: list[str] = []

    async def index(video_id: str) -> tuple[ShotPlan, str]:
        asked.append(video_id)
        return plan, "gemini-4-argon"

    return index, asked


async def test_each_seed_gains_the_new_index_s_assets_and_edits_and_keeps_its_shots() -> None:
    templates = [seed(), seed(OTHER)]
    saved: list[int] = []
    index, asked = indexes()
    await fill_in(templates, index, lambda written: saved.append(len(written)))

    assert asked == [VIDEO, OTHER]
    assert saved == [2, 2]
    for template in templates:
        assert template.plan.shots == seed().plan.shots
        assert [each.id for each in template.plan.assets] == ["chart", "end-card"]
        # Fitted to the seed's own Short, which ends at 4 s.
        assert {each.sourceEndSeconds for each in template.plan.assets} == {4}
        assert [each.type for each in template.plan.edits] == ["layout"]


async def test_only_the_seeds_named_are_indexed_and_drawn_images_follow_their_assets() -> None:
    drawn = {
        "shots": [{"storyboard": f"{AT}/shot-0.png"}],
        "assets": {"chart": f"{AT}/asset-chart.png", "logo": f"{AT}/asset-logo.png"},
    }
    # A seed drawn for an older plan's assets, the chart and a logo.
    older = SeedTemplate.model_validate(
        {
            **seed().model_dump(),
            "plan": {**seed().plan.model_dump(), "assets": [asset(id="chart"), asset(id="logo")]},
            "media": drawn,
        }
    )
    templates = [older, seed(OTHER)]
    index, asked = indexes()
    await fill_in(templates, index, lambda _written: None, frozenset({VIDEO}))

    assert asked == [VIDEO]
    media = templates[0].media
    assert media is not None
    assert media.assets == {"chart": f"{AT}/asset-chart.png"}
    assert media.shots[0].storyboard == f"{AT}/shot-0.png"
    assert templates[1].plan.assets == []


def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_SERVICE_SECRET", SECRET)
    monkeypatch.setenv("AI_DATABASE_URL", "postgresql://u:p@localhost:5432/db")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    get_settings.cache_clear()


async def test_the_command_fills_in_the_seed_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _env(monkeypatch)
    path = tmp_path / "director-seeds.json"
    write_templates([seed(), seed(OTHER)], path)
    index, asked = indexes()

    def indexer(_settings: Settings) -> Indexer:
        return index

    assert await main(["--only", OTHER], path, indexer) == 0
    assert asked == [OTHER]
    first, second = load_templates(path)
    assert (first.plan.assets, [each.id for each in second.plan.assets]) == (
        [],
        ["chart", "end-card"],
    )


async def test_the_command_refuses_a_video_that_isn_t_a_seed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _env(monkeypatch)
    path = tmp_path / "director-seeds.json"
    write_templates([seed()], path)
    index, asked = indexes()
    assert await main(["--only", "NotASeed01"], path, lambda _settings: index) == USAGE_ERROR
    assert asked == []


@pytest.mark.integration
def test_the_command_runs_as_a_module() -> None:
    """Run as the package script runs it: refusing a video that isn't a seed, before it
    calls anything."""
    result = subprocess.run(
        [sys.executable, "-m", "scripts.seed_assets", "--only", "NotASeed01"],
        cwd=APP_ROOT,
        env={**os.environ, "AI_SERVICE_SECRET": SECRET},
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == USAGE_ERROR, result.stderr
