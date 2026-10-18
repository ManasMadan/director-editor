"""Builds apps/ai/app/seeds/templates.json: the plan every one of the 6 seed Shorts
(app/seeds/seeds.json) gets, indexed for real with Gemini on Vertex AI, the same way the
plan job indexes a member's own short (`app.indexing.index_short`). Run from the repo
root whenever the plan schema changes:

    bun run --filter @repo/ai seeds:build

That runs `python -m scripts.build_seeds` from apps/ai with the repo's .env loaded
(apps/ai/package.json); starting from apps/ai is what makes `app` importable, since it
isn't an installed package. Needs the real INDEX_MODEL settings in .env (GOOGLE_API_KEY
a Vertex express-mode key, GOOGLE_VERTEX=true, GOOGLE_CLOUD_PROJECT, VERTEX_LOCATION):
there is no local stand-in for indexing a short, on purpose (CLAUDE.md's "no fakes
outside tests" -- the running app never makes one up, and neither does this script).
gemini-4-argon sometimes answers a video request with a 500 and succeeds on a retry;
`index_short` already retries and falls back, so a seed that still falls back is worth
running again a few times before keeping the fallback's plan.

The 6 seeds' original audio is already captured and uploaded (by a different task, once,
by hand) to gs://director-media-1053522546520/seed-audio/<videoId>.m4a; this script only
records that key (`audio_key`), it never fetches or uploads audio itself.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic_ai.usage import RunUsage, UsageLimits

from app.director import create_index_model, create_planner_agent
from app.indexing import index_short
from app.log import configure_logging, log
from app.schemas import VIDEO_ID_PATTERN, ShotPlan
from app.settings import Settings, get_settings

_APP_ROOT = Path(__file__).resolve().parents[1]
SEEDS_PATH = _APP_ROOT / "app" / "seeds" / "seeds.json"
TEMPLATES_PATH = _APP_ROOT / "app" / "seeds" / "templates.json"

# Indexes a video id into its repaired plan and the name of whichever model wrote it
# (index_short's own return). A function, not index_short itself, so a test can inject a
# stand-in instead of building Gemini models and making a real request.
type Indexer = Callable[[str], Awaitable[tuple[ShotPlan, str]]]


class SeedSource(BaseModel):
    """One row of seeds.json. Only videoId matters here; title/channel/kind are for a
    human choosing the seeds, not for indexing one."""

    model_config = ConfigDict(strict=True, extra="ignore")

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)


class SeedTemplate(BaseModel):
    """One entry of templates.json: a seed's repaired plan, the model that actually wrote
    it, and the Cloud Storage key of its original audio. Task 2.2.2 copies these into
    every new workspace's director_plan rows (source='seed')."""

    model_config = ConfigDict(strict=True, extra="forbid")

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    plan: ShotPlan
    model: str = Field(min_length=1)
    audioKey: str = Field(min_length=1)


def audio_key(video_id: str) -> str:
    """Where `video_id`'s seed audio already sits in Cloud Storage (captured once, by
    hand, by a different task -- see the module docstring)."""
    return f"seed-audio/{video_id}.m4a"


_SEED_SOURCES = TypeAdapter(list[SeedSource])


def load_seeds(path: Path = SEEDS_PATH) -> list[SeedSource]:
    return _SEED_SOURCES.validate_json(path.read_text())


async def build_entry(seed: SeedSource, index: Indexer) -> SeedTemplate:
    plan, model = await index(seed.videoId)
    return SeedTemplate(
        videoId=seed.videoId, plan=plan, model=model, audioKey=audio_key(seed.videoId)
    )


async def build_templates(seeds: list[SeedSource], index: Indexer) -> list[SeedTemplate]:
    """Every seed's template, indexed one at a time and in order (seeds.json's own
    order, so re-running leaves templates.json's diff minimal) rather than concurrently:
    there are only 6, and indexing each one already retries and falls back on its own, so
    nothing is gained by racing them against the same Vertex AI project's quota. A seed
    `index` can't index at all (its retries and its fallback both fail) stops the whole
    run: every seed must end up in templates.json, so a partial file is worse than none."""
    templates: list[SeedTemplate] = []
    for seed in seeds:
        log.info("indexing seed", video_id=seed.videoId)
        template = await build_entry(seed, index)
        log.info("indexed seed", video_id=seed.videoId, model=template.model)
        templates.append(template)
    return templates


def write_templates(templates: list[SeedTemplate], path: Path = TEMPLATES_PATH) -> None:
    path.write_text(
        json.dumps([template.model_dump(mode="json") for template in templates], indent=2) + "\n"
    )


def settings_indexer(settings: Settings) -> Indexer:
    """An `Indexer` that actually calls Gemini: its own pair of planner agents (built the
    same way `Director`'s are, from INDEX_MODEL and INDEX_FALLBACK_MODEL through
    `create_index_model` and `create_planner_agent`), and a token budget of its own
    (DIRECTOR_TOKENS_PER_PLAN) rather than a workspace's reservation, since building
    templates.json isn't a workspace's plan."""
    planner = create_planner_agent(create_index_model(settings, settings.index_model))
    fallback = create_planner_agent(create_index_model(settings, settings.index_fallback_model))

    async def index(video_id: str) -> tuple[ShotPlan, str]:
        usage = RunUsage()
        return await index_short(
            planner,
            settings.index_model,
            fallback,
            settings.index_fallback_model,
            video_id,
            usage,
            UsageLimits(total_tokens_limit=settings.director_tokens_per_plan),
        )

    return index


async def main(seeds_path: Path = SEEDS_PATH, templates_path: Path = TEMPLATES_PATH) -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=False)
    templates = await build_templates(load_seeds(seeds_path), settings_indexer(settings))
    write_templates(templates, templates_path)
    log.info("wrote seed templates", count=len(templates), path=str(templates_path))


if __name__ == "__main__":
    asyncio.run(main())
