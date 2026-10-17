"""Tests for scripts/build_seeds.py, measured for coverage like app/ (apps/ai/pyproject.toml's
`[tool.coverage.run]`). The pure parts (assembling, validating and writing an entry) take
the Gemini call injected; the parts that build the real indexer, and the script run as a
command, talk to the Gemini API's local stand-in (tests/fakes.py), never to Vertex AI,
so they're integration tests (a local HTTP server).
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import TypeAdapter, ValidationError
from pydantic_ai.exceptions import UsageLimitExceeded

from app.schemas import ShotPlan
from app.settings import Settings, get_settings
from scripts.build_seeds import (
    TEMPLATES_PATH,
    SeedSource,
    SeedTemplate,
    audio_key,
    build_entry,
    build_templates,
    load_seeds,
    main,
    settings_indexer,
    write_templates,
)
from tests.fakes import GEMINI_MODEL, GEMINI_PATH, Fake, Reply, gemini_error, gemini_output, serve
from tests.tokens import SECRET

FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
ANGLE: dict[str, object] = {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"}
POSE: dict[str, object] = {"description": "Standing, arms relaxed.", "keypoints": []}


PLAN: dict[str, object] = {
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
FALLBACK_MODEL = "gemini-fallback-test"
FALLBACK_PATH = f"/v1beta/models/{FALLBACK_MODEL}:generateContent"
# A refusal that's about the model, not the video: index_short falls back straight away.
MODEL_REFUSED = gemini_error(404, "NOT_FOUND", "The requested model was not found.")


def shot_plan() -> ShotPlan:
    return ShotPlan.model_validate(PLAN)


def gemini_env(gemini_url: str) -> dict[str, str]:
    """Every setting the script needs, with indexing pointed at the local Gemini API (off
    Vertex) and INDEX_FALLBACK_MODEL distinct from INDEX_MODEL, so a test can tell which
    one answered."""
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


def settings_for(gemini_url: str, **env: str) -> Settings:
    """Settings from exactly these values: the process environment (a loaded .env) must
    not leak in."""
    with patch.dict(os.environ, {}, clear=True):
        return Settings.model_validate({**gemini_env(gemini_url), **env})


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    """The Gemini API: INDEX_MODEL answers with PLAN; a test swaps answers through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {GEMINI_PATH: gemini_output(PLAN)}
    with serve(handlers) as fake:
        yield fake, handlers


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
        return shot_plan(), "gemini-4-argon"

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
    # Every seed's plan has at least one shot: SeedTemplate refuses one without, through
    # ShotPlan's own min_length=1 on shots (app/schemas.py).
    with pytest.raises(ValidationError, match="shots"):
        SeedTemplate.model_validate(
            {
                "videoId": "22k0fZarxh8",
                "plan": {**PLAN, "shots": []},
                "model": "gemini-4-argon",
                "audioKey": "seed-audio/22k0fZarxh8.m4a",
            }
        )


@pytest.mark.integration
async def test_settings_indexer_indexes_with_index_model(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    index = settings_indexer(settings_for(gemini[0].url))

    plan, model = await index("22k0fZarxh8")

    assert plan == shot_plan()
    assert model == GEMINI_MODEL
    [(path, body)] = gemini[0].received
    assert path == GEMINI_PATH
    assert b"https://www.youtube.com/watch?v=22k0fZarxh8" in body


@pytest.mark.integration
async def test_settings_indexer_falls_back_to_index_fallback_model(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    gemini[1][GEMINI_PATH] = MODEL_REFUSED
    gemini[1][FALLBACK_PATH] = gemini_output(PLAN)
    index = settings_indexer(settings_for(gemini[0].url))

    plan, model = await index("22k0fZarxh8")

    assert plan == shot_plan()
    assert model == FALLBACK_MODEL
    assert [path for path, _ in gemini[0].received] == [GEMINI_PATH, FALLBACK_PATH]


@pytest.mark.integration
async def test_settings_indexer_caps_each_seed_at_the_plan_token_budget(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    """Each seed gets a budget of its own (DIRECTOR_TOKENS_PER_PLAN), not a workspace's
    reservation: a run past it fails rather than spending without limit."""
    gemini[1][GEMINI_PATH] = gemini_output(PLAN, tokens=20_000)
    index = settings_indexer(settings_for(gemini[0].url, DIRECTOR_TOKENS_PER_PLAN="10000"))

    with pytest.raises(UsageLimitExceeded):
        _ = await index("22k0fZarxh8")


@pytest.mark.integration
async def test_main_writes_every_seed_s_template(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    seeds = tmp_path / "seeds.json"
    seeds.write_text(json.dumps([{"videoId": "22k0fZarxh8"}, {"videoId": "152Jy2c3XSM"}]))
    templates = tmp_path / "templates.json"
    for key, value in gemini_env(gemini[0].url).items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    try:
        await main(seeds, templates)
    finally:
        get_settings.cache_clear()

    written = TypeAdapter(list[SeedTemplate]).validate_json(templates.read_text())
    assert [(entry.videoId, entry.model, entry.audioKey) for entry in written] == [
        ("22k0fZarxh8", GEMINI_MODEL, "seed-audio/22k0fZarxh8.m4a"),
        ("152Jy2c3XSM", GEMINI_MODEL, "seed-audio/152Jy2c3XSM.m4a"),
    ]


@pytest.mark.integration
def test_the_command_leaves_templates_json_alone_when_a_seed_cant_be_indexed(
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    """`python -m scripts.build_seeds` (what `bun run --filter @repo/ai seeds:build`
    runs, from apps/ai) indexes the real seeds.json; when a seed can't be indexed at all
    it fails without touching the committed templates.json, since a file missing one of
    the 6 is worse than the one already there. Both models refuse here, so nothing this
    test does can overwrite it."""
    gemini[1][GEMINI_PATH] = MODEL_REFUSED
    gemini[1][FALLBACK_PATH] = MODEL_REFUSED
    committed = TEMPLATES_PATH.read_bytes()

    try:
        run = subprocess.run(
            [sys.executable, "-m", "scripts.build_seeds"],
            cwd=TEMPLATES_PATH.parents[2],
            env={**os.environ, **gemini_env(gemini[0].url)},
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        written = TEMPLATES_PATH.read_bytes()
    finally:
        # Should a later change ever let the script write here, the test still leaves
        # the committed file as it found it (and fails on the check below).
        _ = TEMPLATES_PATH.write_bytes(committed)

    assert run.returncode != 0
    assert "ModelHTTPError" in run.stderr
    assert written == committed
    # It got as far as asking Gemini (both models) for the first seed, then stopped.
    assert [path for path, _ in gemini[0].received] == [GEMINI_PATH, FALLBACK_PATH]
