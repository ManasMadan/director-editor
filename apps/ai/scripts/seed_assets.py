"""Fills in the 6 seed templates' assets and edits without making their media again: each
seed is indexed again with Gemini on Vertex AI, the way seeds:build indexes it
(`app.indexing.index_short`), and only the new plan's assets and edits are kept, fitted
to the seed's own shots (`app.plan_repair.with_assets_and_edits`). Its shots stay exactly
as they were, so its storyboard cards, preview clips and music stay true to them, and
every workspace's copy of the seed gets the assets and edits from the committed file
(apps/api's seed-media.ts) with no copy to update. Run from the repo root:

    bun run --filter @repo/ai seeds:assets [-- --only <videoId> ...]

then `bun run --filter @repo/ai seeds:media -- --bucket <bucket>` to draw the default
image of each still among them, and commit the seed file. It needs the same settings as
seeds:build (the real INDEX_MODEL on Vertex AI); each seed it indexes costs a plan's
tokens (DIRECTOR_TOKENS_PER_PLAN at most). The file is written after each seed, so a run
that stops halfway keeps what it got; `--only` runs just the seeds named.
"""

import argparse
import asyncio
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from app.log import configure_logging, log
from app.plan_repair import with_assets_and_edits
from app.settings import Settings, get_settings
from scripts.build_seeds import (
    TEMPLATES_PATH,
    Indexer,
    SeedTemplate,
    load_templates,
    settings_indexer,
    write_templates,
)

# argparse's own exit status for a command used wrongly.
USAGE_ERROR = 2


async def fill_in(
    templates: list[SeedTemplate],
    index: Indexer,
    save: Callable[[list[SeedTemplate]], None],
    only: frozenset[str] = frozenset(),
) -> None:
    """Gives each seed (each of `only`, when it names any) the assets and edits a new
    index of its Short finds, saving after each one. An image already drawn for an asset
    the new plan no longer has is dropped with it."""
    for template in templates:
        if only and template.videoId not in only:
            continue
        log.info("indexing seed again", video_id=template.videoId)
        indexed, model = await index(template.videoId)
        template.plan = with_assets_and_edits(template.plan, indexed)
        if template.media is not None:
            kept = {asset.id for asset in template.plan.assets}
            template.media.assets = {
                asset_id: key for asset_id, key in template.media.assets.items() if asset_id in kept
            }
        save(templates)
        log.info(
            "filled in seed",
            video_id=template.videoId,
            model=model,
            assets=len(template.plan.assets),
            edits=len(template.plan.edits),
        )


class _Arguments(argparse.Namespace):
    only: list[str]


def parse_args(argv: Sequence[str] | None) -> _Arguments:
    parser = argparse.ArgumentParser(description="Fill in the seed templates' assets and edits.")
    parser.add_argument("--only", action="append", default=[], help="Just this video id.")
    return parser.parse_args(argv, namespace=_Arguments())


async def main(
    argv: Sequence[str] | None = None,
    templates_path: Path = TEMPLATES_PATH,
    indexer: Callable[[Settings], Indexer] = settings_indexer,
) -> int:
    arguments = parse_args(argv)
    settings = get_settings()
    configure_logging(settings.log_level, json=False)
    templates = load_templates(templates_path)
    unknown = set(arguments.only) - {template.videoId for template in templates}
    if unknown:
        log.error("not a seed", video_ids=sorted(unknown))
        return USAGE_ERROR
    await fill_in(
        templates,
        indexer(settings),
        lambda written: write_templates(written, templates_path),
        frozenset(arguments.only),
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
