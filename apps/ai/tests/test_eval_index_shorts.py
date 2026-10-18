"""Tests for evals/index_shorts.py, measured for coverage like app/ and scripts/
(apps/ai/pyproject.toml's `[tool.coverage.run]`). The judgement, the repaired-fields diff,
the lines it prints and the run's exit code take the indexing call injected; the parts
that build the real indexer, and the command itself, talk to the Gemini API's local
stand-in (tests/fakes.py), never to Vertex AI, so they're integration tests.
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from app.schemas import ShotPlan, ShotPlanDraft
from app.settings import Settings, get_settings
from evals.index_shorts import (
    APP_ROOT,
    EvalShort,
    Indexed,
    ShortResult,
    describe,
    evaluate,
    evaluate_short,
    judge,
    load_shorts,
    main,
    repaired_fields,
    run_eval,
    settings_indexer,
    summary,
)
from scripts.build_seeds import load_seeds
from tests.fakes import GEMINI_MODEL, GEMINI_PATH, Fake, Reply, gemini_error, gemini_output, serve
from tests.tokens import SECRET

FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
STEP: dict[str, object] = {"atSeconds": 0, "instruction": "Do it.", "cameraMove": "static"}
SHOT: dict[str, object] = {
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
    "phoneAngle": {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"},
    "pose": {"description": "Standing, arms relaxed.", "keypoints": []},
    "steps": [STEP],
    "script": [],
}
PLAN: dict[str, object] = {
    "title": "A plan",
    "format": "GRWM",
    "summary": "A summary.",
    "audio": "none",
    "durationSeconds": 4,
    "shots": [SHOT],
}
SCRIPT_LINE: dict[str, object] = {"startSeconds": 0, "endSeconds": 2, "text": "Hi."}
KEYPOINT: dict[str, object] = {"name": "nose", "x": 0.5, "y": 0.2}
SHORT = EvalShort(
    videoId="22k0fZarxh8",
    title="4 Types of Indian Head Nods",
    channel="Living the Jo Life",
    kind="talking-head",
    why="A seed.",
)
OTHER = EvalShort(
    videoId="152Jy2c3XSM", title="Unboxing", channel="Matty", kind="product", why="A seed."
)
FALLBACK_MODEL = "gemini-fallback-test"
FALLBACK_PATH = f"/v1beta/models/{FALLBACK_MODEL}:generateContent"
# A refusal that's about the model, not the video: index_short falls back straight away.
MODEL_REFUSED = gemini_error(404, "NOT_FOUND", "The requested model was not found.")


def plan_with(*shots: dict[str, object], **plan: object) -> dict[str, object]:
    """PLAN with `plan`'s fields replaced, and each of `shots` as SHOT with those fields
    replaced (PLAN's one shot when none are given)."""
    return {**PLAN, "shots": [{**SHOT, **shot} for shot in shots or ({},)], **plan}


def indexed(plan: dict[str, object] = PLAN, model: str = "gemini-4-argon") -> Indexed:
    return Indexed(
        draft=ShotPlanDraft.model_validate(plan), plan=ShotPlan.model_validate(plan), model=model
    )


def ticking(*times: float) -> Callable[[], float]:
    """A clock that answers `times`, one per call."""
    remaining = list(times)
    return lambda: remaining.pop(0)


def result(**fields: object) -> ShortResult:
    """A passing result for SHORT, with `fields` replaced."""
    plan = ShotPlan.model_validate(PLAN)
    base: dict[str, object] = {
        "short": SHORT,
        "seconds": 12.34,
        "model": "gemini-4-argon",
        "plan": plan,
        "repaired": [],
        "problems": [],
        "error": None,
    }
    return ShortResult.model_validate({**base, **fields})


# ---------------------------------------------------------------------------- shorts.json


def test_shorts_json_has_the_6_seeds_and_6_hard_cases() -> None:
    shorts = load_shorts()
    seeds = load_seeds()

    assert len({short.videoId for short in shorts}) == 12
    assert [short.videoId for short in shorts[:6]] == [seed.videoId for seed in seeds]
    assert [short.kind for short in shorts[6:]] == [
        "no-person",
        "music-only",
        "text-and-doodles",
        "fast-cuts",
        "photo-slideshow",
        "long",
    ]


def test_load_shorts_refuses_a_malformed_video_id(tmp_path: Path) -> None:
    bad = tmp_path / "shorts.json"
    bad.write_text(
        json.dumps([{"videoId": "nope", "title": "T", "channel": "C", "kind": "k", "why": "W"}])
    )
    with pytest.raises(ValidationError):
        load_shorts(bad)


# ---------------------------------------------------------------------------- judgement


def test_judge_passes_a_plan_whose_every_shot_is_complete() -> None:
    assert judge(ShotPlan.model_validate(PLAN)) == []


def test_judge_names_each_shot_missing_a_scene_framing_or_step() -> None:
    """Blank text passes the schema's min_length (a space is a character), so the eval
    checks what a filmer would actually read. A shot with no framing or phoneAngle at all
    can't reach it: ShotPlan refuses one, and indexing fails instead."""
    plan = plan_with(
        {},
        {
            "scene": "  ",
            "framing": {**FRAMING, "note": " "},
            "steps": [{**STEP, "instruction": " "}],
        },
    )

    assert judge(ShotPlan.model_validate(plan)) == [
        "shot 2: no scene",
        "shot 2: no framing",
        "shot 2: no step",
    ]


# ---------------------------------------------------------------------- repaired fields


def test_repaired_fields_is_empty_when_repair_changed_nothing() -> None:
    entry = indexed()
    assert repaired_fields(entry.draft, entry.plan) == []


def test_repaired_fields_names_each_changed_field_once_with_indexes_folded() -> None:
    """Every shot's durationSeconds scaled is one entry, not one per shot; a list whose
    length changed (a step synthesized, a script line dropped) says so."""
    draft = ShotPlanDraft.model_validate(
        plan_with(
            {"durationSeconds": 30, "steps": []},
            {"sourceStartSeconds": 4, "sourceEndSeconds": 8, "durationSeconds": 31},
            durationSeconds=10,
        )
    )
    plan = ShotPlan.model_validate(
        plan_with(
            {"durationSeconds": 29.5, "steps": [{**STEP, "instruction": "Anywhere with light"}]},
            {"sourceStartSeconds": 4, "sourceEndSeconds": 8, "durationSeconds": 30.5},
            durationSeconds=60,
        )
    )

    assert repaired_fields(draft, plan) == [
        "durationSeconds",
        "shots[].durationSeconds",
        "shots[].steps (count)",
    ]


def test_repaired_fields_follows_nested_lists() -> None:
    draft = ShotPlanDraft.model_validate(plan_with({"steps": [{**STEP, "atSeconds": 9}]}))
    plan = ShotPlan.model_validate(plan_with({"steps": [{**STEP, "atSeconds": 4}]}))

    assert repaired_fields(draft, plan) == ["shots[].steps[].atSeconds"]


def test_repaired_fields_counts_a_trimmed_shot_list() -> None:
    draft = ShotPlanDraft.model_validate(plan_with({}, {"sourceStartSeconds": 4.1}))
    plan = ShotPlan.model_validate(PLAN)

    assert repaired_fields(draft, plan) == ["shots (count)"]


# ---------------------------------------------------------------------- one short's run


async def test_evaluate_short_records_the_plan_its_model_time_and_repairs() -> None:
    seen: list[str] = []
    draft_plan = plan_with(durationSeconds=9)

    async def index(video_id: str) -> Indexed:
        seen.append(video_id)
        return Indexed(
            draft=ShotPlanDraft.model_validate(draft_plan),
            plan=ShotPlan.model_validate(PLAN),
            model="gemini-4-argon",
        )

    outcome = await evaluate_short(SHORT, index, ticking(100.0, 112.5))

    assert seen == ["22k0fZarxh8"]
    assert outcome.passed
    assert outcome.seconds == 12.5
    assert outcome.model == "gemini-4-argon"
    assert outcome.repaired == ["durationSeconds"]
    assert outcome.shots == 1
    assert (outcome.has_script, outcome.has_pose) == (False, False)


async def test_evaluate_short_fails_a_plan_the_judgement_fails() -> None:
    async def index(_video_id: str) -> Indexed:
        return indexed(plan_with({"scene": " "}))

    outcome = await evaluate_short(SHORT, index, ticking(0.0, 1.0))

    assert not outcome.passed
    assert outcome.problems == ["shot 1: no scene"]


async def test_evaluate_short_records_why_indexing_failed_without_stopping() -> None:
    """A Short that can't be indexed (a refusal, the token budget, a plan repair can't
    save) fails with its reason; the run goes on to the next."""

    async def index(_video_id: str) -> Indexed:
        raise RuntimeError("Gemini gave up")

    outcome = await evaluate_short(SHORT, index, ticking(0.0, 3.0))

    assert not outcome.passed
    assert outcome.error == "RuntimeError: Gemini gave up"
    assert outcome.model is None
    assert outcome.plan is None
    assert outcome.seconds == 3.0
    assert (outcome.shots, outcome.has_script, outcome.has_pose) == (0, False, False)


async def test_evaluate_indexes_every_short_in_order() -> None:
    seen: list[str] = []

    async def index(video_id: str) -> Indexed:
        seen.append(video_id)
        return indexed()

    outcomes = await evaluate([SHORT, OTHER], index, ticking(0.0, 1.0, 1.0, 2.0))

    assert seen == ["22k0fZarxh8", "152Jy2c3XSM"]
    assert [outcome.short.videoId for outcome in outcomes] == seen


# ---------------------------------------------------------------------- what it prints


def test_describe_a_passing_short() -> None:
    plan = ShotPlan.model_validate(
        plan_with(
            {"script": [SCRIPT_LINE], "pose": {"description": "Up.", "keypoints": [KEYPOINT]}}
        )
    )
    line = describe(result(plan=plan, repaired=["durationSeconds", "shots[].steps (count)"]))

    assert line == (
        "PASS 22k0fZarxh8 talking-head shots=1 script=yes pose=yes model=gemini-4-argon "
        "12.3s repaired=durationSeconds, shots[].steps (count)"
    )


def test_describe_a_short_that_failed_the_judgement() -> None:
    line = describe(result(problems=["shot 1: no scene", "shot 2: no step"]))

    assert line == (
        "FAIL 22k0fZarxh8 talking-head shots=1 script=no pose=no model=gemini-4-argon "
        "12.3s repaired=none problems=shot 1: no scene; shot 2: no step"
    )


def test_describe_a_short_that_failed_to_index() -> None:
    line = describe(result(plan=None, model=None, error="ModelHTTPError: status_code: 500"))

    assert line == (
        "FAIL 22k0fZarxh8 talking-head shots=0 script=no pose=no model=none 12.3s "
        "error=ModelHTTPError: status_code: 500"
    )


def test_summary_counts_passes_indexes_models_repairs_and_time() -> None:
    results = [
        result(seconds=10.0, repaired=["durationSeconds"]),
        result(seconds=20.0, model="gemini-fallback"),
        result(seconds=5.4, plan=None, model=None, error="RuntimeError: no"),
    ]

    assert summary(results) == (
        "2/3 passed, 2/3 indexed, 1 repaired, "
        "models: gemini-4-argon=1, gemini-fallback=1, 35s in all"
    )


async def test_run_eval_exits_zero_only_when_every_short_passes() -> None:
    async def good(_video_id: str) -> Indexed:
        return indexed()

    async def bad(video_id: str) -> Indexed:
        if video_id == OTHER.videoId:
            raise RuntimeError("no")
        return indexed()

    assert await run_eval([SHORT, OTHER], good, ticking(0, 1, 1, 2)) == 0
    assert await run_eval([SHORT, OTHER], bad, ticking(0, 1, 1, 2)) == 1
    assert await run_eval([], good, ticking()) == 1


# ---------------------------------------------------------------------- the command


async def test_main_refuses_to_run_without_live() -> None:
    """Every run spends real Vertex AI tokens on 12 videos: it never happens by accident."""
    assert await main([]) == 2


async def test_main_refuses_an_unknown_only(tmp_path: Path) -> None:
    shorts = tmp_path / "shorts.json"
    shorts.write_text(json.dumps([SHORT.model_dump()]))

    assert await main(["--live", "--only", "152Jy2c3XSM", "--shorts", str(shorts)]) == 2


def gemini_env(gemini_url: str) -> dict[str, str]:
    """Every setting the eval needs, with indexing pointed at the local Gemini API (off
    Vertex) and INDEX_FALLBACK_MODEL distinct from INDEX_MODEL."""
    return {
        "AI_DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379",
        "AI_SERVICE_SECRET": SECRET,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini_url,
        "GOOGLE_VERTEX": "false",
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": FALLBACK_MODEL,
        "LOG_LEVEL": "warning",
    }


def settings_for(gemini_url: str) -> Settings:
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate(gemini_env(gemini_url))


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    """The Gemini API: INDEX_MODEL answers with a plan whose duration repair rewrites."""
    handlers: dict[str, Callable[[bytes], Reply]] = {
        GEMINI_PATH: gemini_output(plan_with(durationSeconds=9))
    }
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.mark.integration
async def test_settings_indexer_returns_gemini_s_draft_and_the_repaired_plan(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    index = settings_indexer(settings_for(gemini[0].url))

    entry = await index("22k0fZarxh8")

    assert entry.draft.durationSeconds == 9
    assert entry.plan == ShotPlan.model_validate(PLAN)
    assert entry.model == GEMINI_MODEL
    assert repaired_fields(entry.draft, entry.plan) == ["durationSeconds"]


@pytest.mark.integration
async def test_settings_indexer_reports_the_fallback_model_s_draft(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    gemini[1][GEMINI_PATH] = MODEL_REFUSED
    gemini[1][FALLBACK_PATH] = gemini_output(plan_with(durationSeconds=7))
    index = settings_indexer(settings_for(gemini[0].url))

    entry = await index("22k0fZarxh8")

    assert entry.draft.durationSeconds == 7
    assert entry.model == FALLBACK_MODEL


@pytest.mark.integration
async def test_main_runs_the_selected_shorts_live(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    shorts = tmp_path / "shorts.json"
    shorts.write_text(json.dumps([SHORT.model_dump(), OTHER.model_dump()]))
    for key, value in gemini_env(gemini[0].url).items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    try:
        code = await main(["--live", "--only", "152Jy2c3XSM", "--shorts", str(shorts)])
    finally:
        get_settings.cache_clear()

    assert code == 0
    [(_, body)] = gemini[0].received
    assert b"https://www.youtube.com/watch?v=152Jy2c3XSM" in body


@pytest.mark.integration
def test_the_command_prints_each_short_and_fails_when_one_does(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    """`python -m evals.index_shorts --live` (what `bun run --filter @repo/ai
    evals:index` runs, from apps/ai) prints a line per Short and the summary, and exits
    non-zero when a Short fails: here both models refuse the second."""
    replies = iter([gemini_output(PLAN), MODEL_REFUSED, MODEL_REFUSED])
    gemini[1][GEMINI_PATH] = lambda body: next(replies)(body)
    gemini[1][FALLBACK_PATH] = MODEL_REFUSED

    run = subprocess.run(
        # The real shorts.json, two of its seeds (SHORT and OTHER).
        [
            sys.executable,
            "-m",
            "evals.index_shorts",
            "--live",
            "--only",
            "22k0fZarxh8",
            "--only",
            "152Jy2c3XSM",
        ],
        cwd=APP_ROOT,
        env={**os.environ, **gemini_env(gemini[0].url)},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert run.returncode == 1, run.stderr
    out = run.stdout + run.stderr
    assert "PASS 22k0fZarxh8 talking-head shots=1" in out
    assert "FAIL 152Jy2c3XSM product shots=0" in out
    assert "ModelHTTPError" in out
    assert "1/2 passed, 1/2 indexed" in out
