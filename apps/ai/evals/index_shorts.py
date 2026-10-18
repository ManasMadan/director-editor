"""The indexing evaluation: indexes the 16 Shorts in evals/shorts.json (the 6 seeds, 6
hard cases and 4 that need more than the viewer filming: assets, voice-overs and edits)
for real, with Gemini on Vertex AI, the same way the plan job indexes a
member's own Short (`app.indexing.index_short`, its retries and fallback included), and
says for each one whether the plan is usable. Run from the repo root:

    bun run --filter @repo/ai evals:index

That runs `python -m evals.index_shorts --live` from apps/ai with the repo's .env loaded
(apps/ai/package.json), like scripts/build_seeds.py. `--live` is required: every run
spends real tokens on every Short, so it never starts by accident. `--only <videoId>`
(repeatable) re-runs just those, and `--save <dir>` writes each plan there. It needs the
same settings as indexing in the app (INDEX_MODEL, INDEX_FALLBACK_MODEL, and Vertex AI's
GOOGLE_* settings), and each Short gets the app's own budget, DIRECTOR_TOKENS_PER_PLAN,
so one that is too long for the app fails here too.

The bar: every Short indexes, every shot of its plan has a scene, a framing, a phone
angle and at least one step, every asset has a prompt and a reference to make it from,
and a Short whose row says what it `expect`s (a split screen, a still to make, voice-over
shots, captions, B-roll gaps, an end card) gets a plan that has it. The command prints a
line per Short (its shots, whether it has a script and a pose, how many assets and edits,
which fields `repair_plan` had to change, the model that answered and how long it took)
and a summary, and exits non-zero unless every Short passed. The Shorts run one at a
time: Vertex AI's quotas are per minute, and gemini-4-argon sometimes answers a video
with a 500 that `index_short` retries anyway.
"""

import argparse
import asyncio
import sys
import time
from collections import Counter
from collections.abc import Awaitable, Callable
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter
from pydantic_ai.usage import RunUsage, UsageLimits

from app.assets import STILL_KINDS
from app.director import create_index_model, create_planner_agent
from app.indexing import index_short
from app.log import configure_logging, log
from app.schemas import (
    VIDEO_ID_PATTERN,
    CaptionStyle,
    LayoutEdit,
    LayoutKind,
    ShotMode,
    ShotPlan,
    ShotPlanDraft,
    TextEdit,
)
from app.settings import Settings, get_settings

APP_ROOT = Path(__file__).resolve().parents[1]
SHORTS_PATH = APP_ROOT / "evals" / "shorts.json"
# argparse's own exit status for a command used wrongly.
USAGE_ERROR = 2


class Expectation(BaseModel):
    """What a Short's plan must have beyond filmable shots, from looking at the Short (spec
    7.5's acceptance, as far as a plan can show it): a layout edit of this kind, split in
    halves (each 50% +/- 5% of the height); at least this many stills to make, one of
    them describing each of `stillText` (in its subject or its text); a shot in each of
    these modes, and none on camera when `voiceOnly`; captions, in this style and on a
    split's seam; lower thirds; a B-roll gap; an end card."""

    model_config = ConfigDict(strict=True, extra="forbid")

    layout: LayoutKind | None = None
    halves: bool = False
    stills: int = Field(default=0, ge=0)
    stillText: list[str] = Field(default_factory=list[str])
    modes: list[ShotMode] = Field(default_factory=list[ShotMode])
    voiceOnly: bool = False
    captions: bool = False
    captionStyle: CaptionStyle | None = None
    captionsBetweenHalves: bool = False
    lowerThirds: bool = False
    gaps: bool = False
    endCard: bool = False


class EvalShort(BaseModel):
    """One row of shorts.json: the Short, why it's in the evaluation, and what its plan
    is expected to have."""

    model_config = ConfigDict(strict=True, extra="forbid")

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    title: str = Field(min_length=1)
    channel: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    why: str = Field(min_length=1)
    expect: Expectation = Field(default_factory=Expectation)


class Indexed(BaseModel):
    """What indexing a Short gave: Gemini's plan as it answered (`draft`), the plan after
    `repair_plan` (`plan`), and the model that wrote it."""

    draft: ShotPlanDraft
    plan: ShotPlan
    model: str


# Indexes a video id. A function, not index_short itself, so a test injects one instead
# of building Gemini models and making a real request.
type Indexer = Callable[[str], Awaitable[Indexed]]
type Clock = Callable[[], float]


class ShortResult(BaseModel):
    """How one Short did: its plan and what repair changed in it, or why it has none."""

    short: EvalShort
    seconds: float
    model: str | None
    plan: ShotPlan | None
    repaired: list[str]
    problems: list[str]
    error: str | None

    @property
    def passed(self) -> bool:
        return self.plan is not None and not self.problems

    @property
    def shots(self) -> int:
        return len(self.plan.shots) if self.plan else 0

    @property
    def assets(self) -> int:
        return len(self.plan.assets) if self.plan else 0

    @property
    def edits(self) -> int:
        return len(self.plan.edits) if self.plan else 0

    @property
    def has_script(self) -> bool:
        return self.plan is not None and any(shot.script for shot in self.plan.shots)

    @property
    def has_pose(self) -> bool:
        return self.plan is not None and any(shot.pose.keypoints for shot in self.plan.shots)


_SHORTS = TypeAdapter(list[EvalShort])
_JSON_OBJECT = TypeAdapter(dict[str, JsonValue])


def load_shorts(path: Path = SHORTS_PATH) -> list[EvalShort]:
    return _SHORTS.validate_json(path.read_text())


def judge(plan: ShotPlan, expect: Expectation | None = None) -> list[str]:
    """What keeps `plan` from being filmable, shot by shot: a scene, a framing and a step
    a filmer can actually read; then what keeps its assets from being made (a prompt and
    a subject to make each from), and what `expect`ed it doesn't have. Blank text gets
    past the schema (a space is a character); a shot with no framing or phone angle at
    all doesn't (ShotPlan refuses it, and indexing fails instead), so those are always
    there by the time a plan is judged."""
    problems: list[str] = []
    for number, shot in enumerate(plan.shots, start=1):
        if not shot.scene.strip():
            problems.append(f"shot {number}: no scene")
        if not shot.framing.note.strip():
            problems.append(f"shot {number}: no framing")
        if not any(step.instruction.strip() for step in shot.steps):
            problems.append(f"shot {number}: no step")
    for asset in plan.assets:
        if not asset.prompt.strip() or not asset.reference.subject.strip():
            problems.append(f"asset {asset.id}: nothing to make it from")
    return problems + _missing(plan, expect or Expectation())


def _missing(plan: ShotPlan, expect: Expectation) -> list[str]:
    """What `expect` asks of the plan that it hasn't."""
    return [
        problem
        for met, problem in [
            *_layout_checks(plan, expect),
            *_still_checks(plan, expect),
            *_shot_checks(plan, expect),
            *_text_checks(plan, expect),
            *_ending_checks(plan, expect),
        ]
        if not met
    ]


type Check = tuple[bool, str]


def _layout_checks(plan: ShotPlan, expect: Expectation) -> list[Check]:
    layouts = [edit for edit in plan.edits if isinstance(edit, LayoutEdit)]
    halves = any(
        edit.layout == "split"
        and edit.cameraShare is not None
        and abs(edit.cameraShare - 0.5) <= 0.05
        for edit in layouts
    )
    return [
        (
            expect.layout is None or any(edit.layout == expect.layout for edit in layouts),
            f"no {expect.layout} layout",
        ),
        (halves or not expect.halves, "no split in halves"),
    ]


def _still_checks(plan: ShotPlan, expect: Expectation) -> list[Check]:
    stills = [asset for asset in plan.assets if asset.kind in STILL_KINDS]
    described = [
        " ".join([asset.reference.subject, *asset.reference.text]).lower() for asset in stills
    ]
    return [
        (len(stills) >= expect.stills, f"{len(stills)} of {expect.stills} stills to make"),
        *[
            (any(word.lower() in each for each in described), f"no still describing {word}")
            for word in expect.stillText
        ],
    ]


def _shot_checks(plan: ShotPlan, expect: Expectation) -> list[Check]:
    on_camera = any(shot.mode == "on-camera" for shot in plan.shots)
    return [
        *[
            (any(shot.mode == mode for shot in plan.shots), f"no {mode} shot")
            for mode in expect.modes
        ],
        (not (expect.voiceOnly and on_camera), "a shot on camera"),
    ]


def _text_checks(plan: ShotPlan, expect: Expectation) -> list[Check]:
    texts = [edit for edit in plan.edits if isinstance(edit, TextEdit)]
    captions = [edit for edit in texts if edit.style == "captions"]
    styled = any(edit.captionStyle == expect.captionStyle for edit in captions)
    between = any(edit.position == "between-halves" for edit in captions)
    return [
        (bool(captions) or not expect.captions, "no captions"),
        (expect.captionStyle is None or styled, f"no {expect.captionStyle} captions"),
        (between or not expect.captionsBetweenHalves, "no captions between the halves"),
        (
            any(edit.style == "lower-third" for edit in texts) or not expect.lowerThirds,
            "no lower thirds",
        ),
    ]


def _ending_checks(plan: ShotPlan, expect: Expectation) -> list[Check]:
    edits = {edit.type for edit in plan.edits}
    end_card = "end-card" in edits or any(asset.kind == "end-card" for asset in plan.assets)
    return [
        ("gap" in edits or not expect.gaps, "no B-roll gap"),
        (end_card or not expect.endCard, "no end card"),
    ]


def repaired_fields(draft: ShotPlanDraft, plan: ShotPlan) -> list[str]:
    """The fields `repair_plan` changed between Gemini's answer and the stored plan, each
    once with list positions folded (`shots[].durationSeconds`, not one per shot), and a
    list whose length changed as `<path> (count)`. Sorted, so runs compare line by line.
    Shots are compared position by position: a plan whose shots repair had to reorder
    shows every field that moved."""
    changed: set[str] = set()
    _diff(
        _JSON_OBJECT.validate_json(draft.model_dump_json()),
        _JSON_OBJECT.validate_json(plan.model_dump_json()),
        "",
        changed,
    )
    return sorted(changed)


def _diff(before: JsonValue, after: JsonValue, path: str, changed: set[str]) -> None:
    if isinstance(before, dict) and isinstance(after, dict):
        for key in before.keys() | after.keys():
            _diff(before.get(key), after.get(key), f"{path}.{key}" if path else key, changed)
    elif isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            changed.add(f"{path} (count)")
        for old, new in zip(before, after, strict=False):
            _diff(old, new, f"{path}[]", changed)
    elif before != after:
        changed.add(path)


async def evaluate_short(short: EvalShort, index: Indexer, clock: Clock) -> ShortResult:
    """Indexes `short` and judges its plan. A Short that can't be indexed (a refusal, the
    token budget, a plan repair can't save) is a failed result with its reason, not an
    error: the rest still run, and the summary counts it."""
    started = clock()
    try:
        entry = await index(short.videoId)
    except Exception as error:
        log.exception("indexing a short failed", video_id=short.videoId)
        return ShortResult(
            short=short,
            seconds=clock() - started,
            model=None,
            plan=None,
            repaired=[],
            problems=[],
            error=f"{type(error).__name__}: {error}",
        )
    return ShortResult(
        short=short,
        seconds=clock() - started,
        model=entry.model,
        plan=entry.plan,
        repaired=repaired_fields(entry.draft, entry.plan),
        problems=judge(entry.plan, short.expect),
        error=None,
    )


async def evaluate(shorts: list[EvalShort], index: Indexer, clock: Clock) -> list[ShortResult]:
    """Every Short's result, one at a time and in order (see the module comment)."""
    results: list[ShortResult] = []
    for short in shorts:
        result = await evaluate_short(short, index, clock)
        log.info(describe(result))
        results.append(result)
    return results


def _yes(value: bool) -> str:
    return "yes" if value else "no"


def describe(result: ShortResult) -> str:
    """One Short's line: pass or fail, what its plan holds, and what went wrong."""
    line = (
        f"{'PASS' if result.passed else 'FAIL'} {result.short.videoId} {result.short.kind} "
        f"shots={result.shots} assets={result.assets} edits={result.edits} "
        f"script={_yes(result.has_script)} pose={_yes(result.has_pose)} "
        f"model={result.model or 'none'} {result.seconds:.1f}s"
    )
    if result.error is not None:
        return f"{line} error={result.error}"
    line += f" repaired={', '.join(result.repaired) or 'none'}"
    if result.problems:
        line += f" problems={'; '.join(result.problems)}"
    return line


def summary(results: list[ShortResult]) -> str:
    total = len(results)
    passed = sum(result.passed for result in results)
    indexed = sum(result.plan is not None for result in results)
    repaired = sum(bool(result.repaired) for result in results)
    models = Counter(result.model for result in results if result.model is not None)
    seconds = sum(result.seconds for result in results)
    return (
        f"{passed}/{total} passed, {indexed}/{total} indexed, {repaired} repaired, "
        f"models: {', '.join(f'{model}={count}' for model, count in sorted(models.items()))}, "
        f"{seconds:.0f}s in all"
    )


async def run_eval(
    shorts: list[EvalShort], index: Indexer, clock: Clock, save: Path | None = None
) -> int:
    """Evaluates `shorts`, prints the summary, and answers the command's exit status: 0
    only when there was something to evaluate and every Short passed. With `save`, each
    plan is also written there as `<videoId>.json`, to read what Gemini made of it."""
    results = await evaluate(shorts, index, clock)
    log.info(summary(results))
    if save is not None:
        save_plans(results, save)
    return 0 if results and all(result.passed for result in results) else 1


def save_plans(results: list[ShortResult], save: Path) -> None:
    """Each Short's plan as `<videoId>.json` in `save` (a Short with none has no file)."""
    save.mkdir(parents=True, exist_ok=True)
    for result in results:
        if result.plan is not None:
            (save / f"{result.short.videoId}.json").write_text(
                result.plan.model_dump_json(indent=2)
            )


def settings_indexer(settings: Settings) -> Indexer:
    """An `Indexer` that actually calls Gemini, built like the app's (INDEX_MODEL, then
    INDEX_FALLBACK_MODEL) with the app's per-plan budget, and that keeps Gemini's answer
    from before repair so the result can say what repair changed."""
    planner = create_planner_agent(create_index_model(settings, settings.index_model))
    fallback = create_planner_agent(create_index_model(settings, settings.index_fallback_model))

    async def index(video_id: str) -> Indexed:
        drafts: list[ShotPlanDraft] = []
        plan, model = await index_short(
            planner,
            settings.index_model,
            fallback,
            settings.index_fallback_model,
            video_id,
            RunUsage(),
            UsageLimits(total_tokens_limit=settings.director_tokens_per_plan),
            drafted=drafts.append,
        )
        # index_short hands over one draft per run that returns: the one it repaired.
        return Indexed(draft=drafts[-1], plan=plan, model=model)

    return index


class Arguments(argparse.Namespace):
    live: bool
    only: list[str]
    shorts: Path
    save: Path | None


def _arguments(argv: list[str]) -> Arguments:
    parser = argparse.ArgumentParser(prog="python -m evals.index_shorts")
    parser.add_argument("--live", action="store_true", help="Index on Vertex AI for real.")
    parser.add_argument("--only", action="append", default=[], help="Just this video id.")
    parser.add_argument("--shorts", type=Path, default=SHORTS_PATH, help="The Shorts' file.")
    parser.add_argument("--save", type=Path, default=None, help="Write each plan here.")
    return parser.parse_args(argv, namespace=Arguments())


async def main(argv: list[str]) -> int:
    arguments = _arguments(argv)
    configure_logging("info", json=False)
    if not arguments.live:
        log.error("indexing spends real Vertex AI tokens on every Short: pass --live")
        return USAGE_ERROR
    shorts = load_shorts(arguments.shorts)
    if arguments.only:
        unknown = set(arguments.only) - {short.videoId for short in shorts}
        if unknown:
            log.error("not in the Shorts' file", video_ids=sorted(unknown))
            return USAGE_ERROR
        shorts = [short for short in shorts if short.videoId in arguments.only]
    return await run_eval(shorts, settings_indexer(get_settings()), time.monotonic, arguments.save)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
