"""Builds packages/contracts/src/director-seeds.json: the plan every one of the 6 seed
Shorts (app/seeds/seeds.json) gets, indexed for real with Gemini on Vertex AI, the same way the
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

Each seed's generated media (storyboard cards, preview clips and a music track) is made
afterwards by scripts/seed_media.py, which only adds keys to this file. Rebuilding keeps
the media keys of every seed whose plan came out exactly the same (`keep_media`) and
drops those of a seed whose plan changed, so run this first and seed_media after it.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.main import IncEx
from pydantic_ai.usage import RunUsage, UsageLimits

from app.director import create_index_model, create_planner_agent
from app.indexing import index_short
from app.log import configure_logging, log
from app.schemas import VIDEO_ID_PATTERN, ShotPlan
from app.settings import Settings, get_settings

APP_ROOT = Path(__file__).resolve().parents[1]
SEEDS_PATH = APP_ROOT / "app" / "seeds" / "seeds.json"
# In packages/contracts, not here: apps/api copies these templates into every new
# workspace, bundled into its build, and services never import each other's files. The
# contracts package parses it against the plan's contract when the API loads it.
TEMPLATES_PATH = APP_ROOT.parents[1] / "packages" / "contracts" / "src" / "director-seeds.json"

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
    """One entry of director-seeds.json: a seed's repaired plan, the model that actually wrote
    it, and the Cloud Storage key of its original audio. apps/api copies these into every
    new workspace's director_plan rows (source='seed')."""

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
    order, so re-running leaves the file's diff minimal) rather than concurrently:
    there are only 6, and indexing each one already retries and falls back on its own, so
    nothing is gained by racing them against the same Vertex AI project's quota. A seed
    `index` can't index at all (its retries and its fallback both fail) stops the whole
    run: every seed must end up in the file, so a partial file is worse than none."""
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


_TEMPLATES = TypeAdapter(list[SeedTemplate])


def load_templates(path: Path = TEMPLATES_PATH) -> list[SeedTemplate]:
    """The seed file as it stands; empty when there is none yet."""
    return _TEMPLATES.validate_json(path.read_text()) if path.exists() else []


# A plan's media keys (scripts/seed_media.py), left out to compare two plans' content.
_MEDIA_KEYS: IncEx = {
    "musicKey": True,
    "shots": {"__all__": {"storyboardKey", "previewKey"}},
}


def _content(plan: ShotPlan) -> dict[str, object]:
    return plan.model_dump(mode="json", exclude=_MEDIA_KEYS)


def keep_media(templates: list[SeedTemplate], previous: list[SeedTemplate]) -> list[SeedTemplate]:
    """`templates` with the media keys of each seed whose plan came out exactly as it
    was. A seed whose plan changed starts without media, since media drawn from the old
    shots would show the wrong scenes: run scripts/seed_media.py after this to make it
    again."""
    earlier = {template.videoId: template.plan for template in previous}

    def kept(template: SeedTemplate) -> SeedTemplate:
        plan = earlier.get(template.videoId)
        if plan is None or _content(plan) != _content(template.plan):
            return template
        return template.model_copy(update={"plan": plan})

    return [kept(template) for template in templates]


def settings_indexer(settings: Settings) -> Indexer:
    """An `Indexer` that actually calls Gemini: its own pair of planner agents (built the
    same way `Director`'s are, from INDEX_MODEL and INDEX_FALLBACK_MODEL through
    `create_index_model` and `create_planner_agent`), and a token budget of its own
    (DIRECTOR_TOKENS_PER_PLAN) rather than a workspace's reservation, since building
    the seed templates isn't a workspace's plan."""
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
    write_templates(keep_media(templates, load_templates(templates_path)), templates_path)
    log.info("wrote seed templates", count=len(templates), path=str(templates_path))


if __name__ == "__main__":
    asyncio.run(main())
