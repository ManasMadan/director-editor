"""A gap's Veo clip, from the member's ask in the picker to the stored MP4, against real
Postgres and Redis, with Vertex AI (Gemini, Nano Banana and Veo) and Cloud Storage as
the local stand-ins in tests/fakes.py. Veo is reached only on Vertex, so the service
runs on Vertex here, as in production."""

from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app import clips
from tests.fakes import (
    ASSET_MODEL,
    GCS_UPLOAD,
    GEMINI_MODEL,
    MEDIA_BUCKET,
    VEO_RUNNING,
    VERTEX_PROJECT,
    Fake,
    Reply,
    gcs_uploaded,
    gemini_error,
    gemini_image,
    gemini_output,
    serve,
    veo_done,
    veo_polls,
    veo_started,
    vertex_path,
)
from tests.support import as_org, headers, new_org
from tests.test_assets import ASSET_PLAN, PNG, images, indexed, make, uploads
from tests.test_director import VIDEO, fake_yt_dlp, usage

pytestmark = pytest.mark.integration

VEO = "veo-test"
START = vertex_path("us-central1", VEO, "predictLongRunning")
POLL = vertex_path("us-central1", VEO, "fetchPredictOperation")
# The first shot's B-roll slot, for when the member skips it.
GAP = "shot-1"
CLIP_TOKENS = 60_000

type Google = tuple[Fake, dict[str, Callable[[bytes], Reply]]]


@pytest.fixture
def google(monkeypatch: pytest.MonkeyPatch) -> Iterator[Google]:
    # Polled at once rather than every ten seconds.
    monkeypatch.setattr(clips, "_POLL_SECONDS", 0)
    handlers: dict[str, Callable[[bytes], Reply]] = {
        vertex_path("global", GEMINI_MODEL, "generateContent"): gemini_output(ASSET_PLAN),
        vertex_path("global", ASSET_MODEL, "generateContent"): gemini_image(PNG),
        START: veo_started(VEO),
        POLL: veo_polls(VEO, VEO_RUNNING, veo_done(b"\x00\x00\x00\x18ftypmp42")),
        GCS_UPLOAD: gcs_uploaded,
    }
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(google: Google, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    monkeypatch.setenv("PATH", fake_yt_dlp(tmp_path, exit_code=1))
    monkeypatch.setenv("STORAGE_EMULATOR_HOST", google[0].url)
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "ASSET_MODEL": ASSET_MODEL,
        "VEO_MODEL": VEO,
        "DIRECTOR_TOKENS_PER_CLIP": str(CLIP_TOKENS),
        "GOOGLE_VERTEX": "true",
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_CLOUD_PROJECT": VERTEX_PROJECT,
        "GOOGLE_BASE_URL": google[0].url,
        "MEDIA_BUCKET": MEDIA_BUCKET,
    }


def ask_for_a_clip(client: TestClient) -> tuple[UUID, UUID]:
    """A workspace with the plan indexed and its defaults drawn, and the member's clip
    for the first shot's gap asked for; the workspace and the plan."""
    org, user = new_org()
    plan_id = indexed(client, org, user)
    make(client, org, plan_id)
    response = client.post(
        f"/v1/director/plans/{VIDEO}/assets/{GAP}/drawings",
        json={
            "prompt": "A kettle coming to the boil",
            "instruction": None,
            "baseId": None,
            "referenceKey": None,
            "demo": False,
            "clip": True,
        },
        headers=headers(org, user),
    )
    assert response.status_code == 201, response.text
    return org, plan_id


def clip_of(org: UUID, plan_id: UUID) -> tuple[object, ...]:
    [clip] = [row for row in images(org, plan_id) if row[0] == GAP]
    return clip


def test_a_gap_s_clip_is_made_by_veo_stored_and_counted(client: TestClient, google: Google) -> None:
    org, plan_id = ask_for_a_clip(client)
    stills = usage(org, "director-asset")

    make(client, org, plan_id)

    _, status, key, error = clip_of(org, plan_id)
    assert (status, error) == ("ready", None)
    assert isinstance(key, str)
    assert key.startswith(f"director-assets/{plan_id}/{GAP}/")
    assert key.endswith(".mp4")
    [sent] = [body for body in uploads(google[0]) if b"video/mp4" in body]
    assert b"ftypmp42" in sent
    # Veo is counted at its fixed price per clip.
    assert usage(org, "director-asset") == stills + CLIP_TOKENS


def test_a_clip_veo_can_t_make_fails_once_and_costs_nothing(
    client: TestClient, google: Google
) -> None:
    org, plan_id = ask_for_a_clip(client)
    google[1][START] = gemini_error(500, "INTERNAL")
    stills = usage(org, "director-asset")

    make(client, org, plan_id)

    assert clip_of(org, plan_id)[1:] == ("failed", None, "UPSTREAM_UNAVAILABLE")
    assert usage(org, "director-asset") == stills


# The month's allowance in the tests is 2,000,000 tokens (AI_MONTHLY_TOKENS_PER_ORG).
@pytest.mark.parametrize(
    "spent",
    [
        # Less left than one clip is counted as.
        1_950_000,
        # Nothing left at all.
        2_000_000,
    ],
)
def test_a_clip_waits_for_a_whole_clip_s_worth_of_allowance(
    client: TestClient, google: Google, spent: int
) -> None:
    org, plan_id = ask_for_a_clip(client)
    _ = as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', %s, 0)",
        (org, spent),
    )
    asked = len(google[0].received)

    make(client, org, plan_id)

    assert clip_of(org, plan_id)[1:] == ("failed", None, "AI_BUDGET_EXCEEDED")
    assert START not in [path for path, _ in google[0].received[asked:]]


def test_a_clip_another_job_is_making_is_never_made_twice(
    client: TestClient, google: Google
) -> None:
    """Two jobs can list the same clip: one claimed a moment ago is left to the job that
    claimed it, since a Veo clip made twice is billed twice."""
    org, plan_id = ask_for_a_clip(client)
    claimed = as_org(
        org,
        "UPDATE ai.director_asset SET status = 'generating', updated_at = now()"
        " WHERE plan_id = %s AND asset_id = %s RETURNING id",
        (plan_id, GAP),
    )
    assert len(claimed) == 1
    asked = len(google[0].received)
    stills = usage(org, "director-asset")

    make(client, org, plan_id)

    assert clip_of(org, plan_id)[1:] == ("generating", None, None)
    assert START not in [path for path, _ in google[0].received[asked:]]
    assert usage(org, "director-asset") == stills
