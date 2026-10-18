"""The default images of a plan's assets against real Postgres and Redis, with local
stand-ins for Gemini (the planner and Nano Banana) and Cloud Storage that speak their real
protocols (tests/fakes.py): what indexing claims within the limits, the job that draws
and stores them, how a plan serves them, every way a drawing can fail, the token ledger,
and tenancy."""

import asyncio
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.assets import MAX_DEFAULT_ASSETS, AssetsInterrupted, images_lock_key
from app.plan_repair import repair_plan
from app.schemas import ShotPlanDraft
from app.settings import get_settings
from app.worker import director_processor
from tests.fakes import (
    ASSET_MODEL,
    ASSET_PATH,
    GCS_UPLOAD,
    GEMINI_MODEL,
    GEMINI_PATH,
    MEDIA_BUCKET,
    Fake,
    Reply,
    gcs_uploaded,
    gemini_error,
    gemini_image,
    gemini_output,
    serve,
    vertex_text_only,
)
from tests.support import (
    ENV,
    as_org,
    migrator,
    new_org,
    on_app_loop,
    published,
    redis_client,
    stored_job,
    subscribe,
)
from tests.test_director import (
    PLAN,
    VIDEO,
    Activities,
    Job,
    director,
    fake_yt_dlp,
    index_plan,
    insert_plan,
    plan_of,
    spend_the_month,
    usage,
)
from tests.test_plan_repair_assets import edit

pytestmark = pytest.mark.integration

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
IMAGE_TOKENS = 1_590


def asset(asset_id: str, kind: str = "image", ratio: str = "9:8") -> dict[str, object]:
    return {
        "id": asset_id,
        "kind": kind,
        "title": f"The {asset_id}",
        "role": "Under the speaker, in the bottom half of a split screen",
        "description": "A static infographic ranking twelve archetypes.",
        "reference": {
            "subject": "Twelve thinking archetypes, a small portrait on each row",
            "composition": "Title across the top, twelve rows below",
            "style": "Flat vector infographic",
            "palette": "Black and white",
            "blackAndWhite": True,
            "aspectRatio": ratio,
            "text": ["12 MALE ARCHETYPES"],
            "brands": [],
            "mood": "Bold",
        },
        "prompt": 'A flat black-and-white infographic titled "12 MALE ARCHETYPES".',
        "sourceStartSeconds": 0,
        "sourceEndSeconds": 10,
        "defaultSource": "create",
        "personalisable": True,
        "ask": None,
        "secondScreen": False,
    }


# The OvRozQobeuI shape: a chart under the speaker, captions, an end card, and music that
# gets no image.
ASSET_PLAN: dict[str, object] = {
    **PLAN,
    "assets": [
        asset("chart"),
        asset("card", kind="text-card", ratio="1:1"),
        asset("music", kind="music"),
        asset("end-card", kind="end-card", ratio="9:16"),
    ],
    "edits": [
        edit(
            "layout",
            endSeconds=10,
            layout="split",
            assetId="chart",
            cameraOn="top",
            cameraShare=0.5,
        ),
        edit("text", endSeconds=10, style="captions"),
    ],
}
STILLS = ["chart", "card", "end-card"]


@pytest.fixture
def google() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    """Gemini (the planner and Nano Banana) and Cloud Storage's upload, on one server; a
    test swaps what each answers with through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {
        GEMINI_PATH: gemini_output(ASSET_PLAN),
        ASSET_PATH: gemini_image(PNG),
        GCS_UPLOAD: gcs_uploaded,
    }
    with serve(handlers) as fake:
        yield fake, handlers


def _env(google_url: str) -> dict[str, str]:
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": google_url,
        "MEDIA_BUCKET": MEDIA_BUCKET,
        "ASSET_MODEL": ASSET_MODEL,
    }


@pytest.fixture
def extra_env(
    google: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> dict[str, str]:
    # The audio capture that comes with MEDIA_BUCKET fails at once (no network), and
    # google-cloud-storage uploads to the stand-in, anonymously.
    monkeypatch.setenv("PATH", fake_yt_dlp(tmp_path, exit_code=1))
    monkeypatch.setenv("STORAGE_EMULATOR_HOST", google[0].url)
    return _env(google[0].url)


@contextmanager
def _client(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> Generator[TestClient]:
    for key, value in {**ENV, **env}.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    redis_client().flushdb()  # pyright: ignore[reportUnknownMemberType]  # untyped options
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


def indexed(client: TestClient, org: UUID, user: UUID) -> UUID:
    plan = index_plan(client, org, user)
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    return plan.id


def make(client: TestClient, org: UUID, plan_id: UUID, *, final: bool = True) -> None:
    on_app_loop(client, lambda: director().make_assets(org, plan_id, final=final))


def images(org: UUID, plan_id: UUID) -> list[tuple[object, ...]]:
    return as_org(
        org,
        """SELECT asset_id, status, object_key, error FROM ai.director_asset
            WHERE plan_id = %s ORDER BY id""",
        (plan_id,),
    )


def assets_job(plan_id: UUID) -> dict[bytes, bytes]:
    return stored_job(f"{{ai-director}}:ai-director:{plan_id}-assets")


def uploads(fake: Fake) -> list[bytes]:
    return [body for path, body in fake.received if path == GCS_UPLOAD]


def drawings(fake: Fake) -> list[bytes]:
    return [body for path, body in fake.received if path == ASSET_PATH]


def test_indexing_claims_an_image_for_each_still_and_queues_their_job(client: TestClient) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)

    assert images(org, plan_id) == [(name, "pending", None, None) for name in STILLS]
    [(owner,)] = as_org(
        org, "SELECT DISTINCT user_id FROM ai.director_asset WHERE plan_id = %s", (plan_id,)
    )
    assert owner == user
    assert assets_job(plan_id)[b"name"] == b"assets"
    served = plan_of(client, org, user)
    assert served.plan is not None
    assert [each.id for each in served.plan.assets] == ["chart", "card", "music", "end-card"]
    assert [(each.assetId, each.status) for each in served.assetImages] == [
        (name, "pending") for name in STILLS
    ]


def test_the_assets_job_draws_and_stores_each_image(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    events = subscribe(f"realtime:org:{org}")
    make(client, org, plan_id)

    keys = [f"director-assets/{plan_id}/{name}.png" for name in STILLS]
    assert images(org, plan_id) == [
        (name, "ready", key, None) for name, key in zip(STILLS, keys, strict=True)
    ]
    assert [(each.status, each.objectKey) for each in plan_of(client, org, user).assetImages] == [
        ("ready", key) for key in keys
    ]
    # Each one stored under the plan, as the image Nano Banana drew.
    stored = uploads(google[0])
    assert all(f'"name": "{key}"'.encode() in body for body, key in zip(stored, keys, strict=True))
    assert all(PNG in body and b"image/png" in body for body in stored)
    # Asked for in the reference's look and shape (half a split screen drawn 5:4).
    chart, card, end_card = drawings(google[0])
    assert b"spelt exactly" in chart
    assert b"Black and white only" in chart
    assert b'"aspectRatio": "5:4"' in chart
    assert b'"aspectRatio": "1:1"' in card
    assert b'"aspectRatio": "9:16"' in end_card
    assert b"not a likeness" in chart
    assert usage(org, "director-asset") == IMAGE_TOKENS * len(STILLS)
    assert published(events) == [{"type": "director.changed"}] * len(STILLS)
    # Again: nothing left to draw, nothing drawn.
    make(client, org, plan_id)
    assert len(drawings(google[0])) == len(STILLS)


def test_a_plan_gets_at_most_five_default_images(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    many = [asset(f"still-{n}") for n in range(MAX_DEFAULT_ASSETS + 2)]
    google[1][GEMINI_PATH] = gemini_output({**ASSET_PLAN, "assets": many})
    org, user = new_org()
    plan_id = indexed(client, org, user)
    assert [row[0] for row in images(org, plan_id)] == [
        f"still-{n}" for n in range(MAX_DEFAULT_ASSETS)
    ]


def _made_elsewhere(user: UUID, count: int) -> None:
    """`count` images made for `user` in another workspace today."""
    other, _ = new_org()
    plan_id = insert_plan(other, VIDEO)
    for n in range(count):
        as_org(
            other,
            """INSERT INTO ai.director_asset (org_id, plan_id, user_id, asset_id, updated_at)
               VALUES (%s, %s, %s, %s, now())""",
            (other, plan_id, user, f"made-{n}"),
        )


def test_a_member_s_images_stop_at_thirty_a_day_in_every_workspace(client: TestClient) -> None:
    org, user = new_org()
    _made_elsewhere(user, 28)
    plan_id = indexed(client, org, user)
    assert [row[0] for row in images(org, plan_id)] == ["chart", "card"]


def test_a_member_past_the_day_s_limit_gets_no_images_and_no_job(client: TestClient) -> None:
    org, user = new_org()
    _made_elsewhere(user, 30)
    plan_id = indexed(client, org, user)
    assert images(org, plan_id) == []
    assert assets_job(plan_id) == {}


def test_a_plan_without_stills_claims_nothing(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    google[1][GEMINI_PATH] = gemini_output(PLAN)
    org, user = new_org()
    plan_id = indexed(client, org, user)
    assert images(org, plan_id) == []
    assert plan_of(client, org, user).assetImages == []


def test_a_plan_nobody_indexed_counts_against_nobody_s_day(client: TestClient) -> None:
    org, _ = new_org()
    [(plan_id,)] = as_org(
        org,
        """INSERT INTO ai.director_plan (org_id, video_id, source, status, stage, updated_at)
           VALUES (%s, %s, 'user', 'pending', 'queued', now())
           RETURNING id""",
        (org, VIDEO),
    )
    assert isinstance(plan_id, UUID)
    on_app_loop(client, lambda: director().analyze(org, plan_id, None))
    rows = as_org(org, "SELECT user_id FROM ai.director_asset WHERE plan_id = %s", (plan_id,))
    assert rows == [(None,)] * len(STILLS)


def test_a_retry_of_a_saved_plan_queues_images_still_waiting(client: TestClient) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    redis_client().delete(f"{{ai-director}}:ai-director:{plan_id}-assets")
    on_app_loop(client, lambda: director().analyze(org, plan_id, user))
    assert assets_job(plan_id)[b"name"] == b"assets"
    # Once they're drawn, a retry queues nothing.
    make(client, org, plan_id)
    redis_client().delete(f"{{ai-director}}:ai-director:{plan_id}-assets")
    on_app_loop(client, lambda: director().analyze(org, plan_id, user))
    assert assets_job(plan_id) == {}


@pytest.mark.parametrize(
    "outage",
    [
        (ASSET_PATH, gemini_error(500, "INTERNAL")),
        (ASSET_PATH, gemini_error(429, "RESOURCE_EXHAUSTED")),
        # Storage failing is an outage here too; a 403 because google-cloud-storage retries a
        # 503 itself for two minutes before it gives up.
        (GCS_UPLOAD, gemini_error(403, "FORBIDDEN")),
    ],
    ids=["gemini-down", "gemini-busy", "storage-down"],
)
def test_an_outage_puts_the_image_back_for_the_retry_then_fails_it(
    client: TestClient,
    google: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    outage: tuple[str, Callable[[bytes], Reply]],
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    path, answer = outage
    google[1][path] = answer
    with pytest.raises(AssetsInterrupted):
        make(client, org, plan_id, final=False)
    assert [row[1] for row in images(org, plan_id)] == ["pending"] * len(STILLS)
    make(client, org, plan_id, final=True)
    assert images(org, plan_id) == [
        (name, "failed", None, "UPSTREAM_UNAVAILABLE") for name in STILLS
    ]


@pytest.mark.parametrize(
    "answer", [gemini_error(400, "INVALID_ARGUMENT"), vertex_text_only], ids=["refused", "words"]
)
def test_a_refusal_or_an_answer_without_an_image_fails_it_at_once(
    client: TestClient,
    google: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    answer: Callable[[bytes], Reply],
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    google[1][ASSET_PATH] = answer
    make(client, org, plan_id, final=False)
    assert [row[1:] for row in images(org, plan_id)] == [
        ("failed", None, "UPSTREAM_UNAVAILABLE")
    ] * len(STILLS)
    assert usage(org, "director-asset") == 0


def test_no_budget_left_fails_the_images(client: TestClient) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    spend_the_month(org)
    make(client, org, plan_id)
    assert [row[3] for row in images(org, plan_id)] == ["AI_BUDGET_EXCEEDED"] * len(STILLS)


def test_a_budget_too_small_for_a_whole_image_fails_it_and_gives_the_rest_back(
    client: TestClient,
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    [(used,)] = as_org(
        org, "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage", ()
    )
    assert isinstance(used, int)
    left = 1_000
    as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', %s, 0)",
        (org, 2_000_000 - used - left),
    )
    make(client, org, plan_id)
    assert [row[3] for row in images(org, plan_id)] == ["AI_BUDGET_EXCEEDED"] * len(STILLS)
    assert usage(org, "director-asset") == 0


def test_without_a_bucket_no_image_is_claimed_or_drawn(
    monkeypatch: pytest.MonkeyPatch,
    google: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
) -> None:
    env = {key: value for key, value in _env(google[0].url).items() if key != "MEDIA_BUCKET"}
    with _client(monkeypatch, {**env, "MEDIA_BUCKET": ""}) as test:
        org, user = new_org()
        plan_id = indexed(test, org, user)
        make(test, org, plan_id)
    assert images(org, plan_id) == []
    assert assets_job(plan_id) == {}
    assert drawings(google[0]) == []


def test_a_job_for_a_plan_that_s_gone_draws_nothing(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, _ = new_org()
    make(client, org, uuid4())
    assert drawings(google[0]) == []


def test_another_workspace_never_sees_a_plan_s_images(client: TestClient) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    other, _ = new_org()
    # Read as the service reads them, as app_ai under row-level security.
    assert on_app_loop(client, lambda: director().asset_images(other, plan_id)) == []
    assert len(on_app_loop(client, lambda: director().asset_images(org, plan_id))) == len(STILLS)


def test_the_worker_runs_the_assets_job_and_logs_each_image_and_the_job(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    activities = Activities()
    monkeypatch.setattr("app.assets.log_activity", activities)
    monkeypatch.setattr("app.worker.log_activity", activities)
    process = director_processor(director())
    meta = {"requestId": "req-1", "userId": str(user), "orgId": str(org)}
    job = Job("assets", {"meta": meta, "payload": {"planId": str(plan_id), "orgId": str(org)}})
    on_app_loop(client, lambda: process(job))
    assert [row[1] for row in images(org, plan_id)] == ["ready"] * len(STILLS)
    # An activity line per image, for the member it counts against, with what it used.
    drawn = activities.named("director.asset_drawn")
    assert [(fields["target"], fields["user_id"]) for fields, _ in drawn] == [
        (
            {
                "planId": str(plan_id),
                "assetId": name,
                "model": ASSET_MODEL,
                "inputTokens": 300,
                "outputTokens": 1_290,
            },
            user,
        )
        for name in STILLS
    ]
    # And the job's own line, like every other job's.
    [(finished, bound)] = activities.named("job.finished")
    assert finished["target"] == {
        "queue": "ai-director",
        "job": "assets",
        "jobId": "job-1",
        "attempt": 1,
    }
    assert bound == str(user)


def test_a_failed_image_s_activity_says_why(
    client: TestClient,
    google: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    activities = Activities()
    monkeypatch.setattr("app.assets.log_activity", activities)
    google[1][ASSET_PATH] = vertex_text_only
    make(client, org, plan_id)
    spend_the_month(org)
    as_org(org, "UPDATE ai.director_asset SET status = 'pending' WHERE plan_id = %s", (plan_id,))
    make(client, org, plan_id)
    outcomes = [
        (fields["outcome"], fields["reason"])
        for fields, _ in activities.named("director.asset_drawn")
    ]
    assert outcomes == [("failed", "UPSTREAM_UNAVAILABLE")] * len(STILLS) + [
        ("refused", "AI_BUDGET_EXCEEDED")
    ] * len(STILLS)


def test_an_image_whose_asset_the_plan_no_longer_has_is_failed_not_drawn(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    # The plan indexed again with other assets, after its first images were claimed.
    stored = repair_plan(ShotPlanDraft.model_validate({**ASSET_PLAN, "assets": []}), None)
    as_org(
        org,
        "UPDATE ai.director_plan SET plan = %s WHERE id = %s",
        (Jsonb(stored.model_dump(mode="json")), plan_id),
    )
    make(client, org, plan_id)
    assert images(org, plan_id) == [(name, "failed", None, "VALIDATION_FAILED") for name in STILLS]
    assert drawings(google[0]) == []


def test_a_plan_not_ready_has_nothing_drawn_yet(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    plan_id = indexed(client, org, user)
    as_org(org, "UPDATE ai.director_plan SET status = 'pending' WHERE id = %s", (plan_id,))
    make(client, org, plan_id)
    assert [row[1] for row in images(org, plan_id)] == ["pending"] * len(STILLS)
    assert drawings(google[0]) == []


def test_a_member_s_claims_take_turns_on_their_own_lock(client: TestClient) -> None:
    """Held by one claim's transaction, the member's lock keeps another from reading the
    day's count until the first has written its rows."""
    org, user = new_org()
    with migrator() as db, db.transaction():
        db.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (images_lock_key(user),)
        )
        plan = index_plan(client, org, user)

        async def analyze() -> None:
            await asyncio.wait_for(director().analyze(org, plan.id, user), timeout=1)

        with pytest.raises(TimeoutError):
            on_app_loop(client, analyze)
    assert images(org, plan.id) == []
    plan_id = indexed(client, org, user)
    assert len(images(org, plan_id)) == len(STILLS)


def test_the_original_s_branding_never_reaches_the_drawing(
    client: TestClient, google: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    branded = asset("end-card", kind="end-card", ratio="9:16")
    reference = branded["reference"]
    assert isinstance(reference, dict)
    branded |= {
        "prompt": 'A black end card with "Mesa School" and "Apply Now" in purple.',
        "reference": {
            **reference,
            "text": ["MESA SCHOOL", "Apply now at mesaschool.co", "@mesa.school"],
            "brands": ["Mesa School"],
        },
    }
    google[1][GEMINI_PATH] = gemini_output({**ASSET_PLAN, "assets": [branded]})
    org, user = new_org()
    make(client, org, indexed(client, org, user))
    [drawing] = drawings(google[0])
    sent = drawing.decode().lower()
    assert "mesa" not in sent
    assert "your name" in sent
    assert "yourwebsite.com" in sent
    assert "@yourname" in sent
    # The rest of its words still go as they are.
    assert "apply now" in sent


def test_a_stored_plan_with_assets_and_edits_reads_back_whole(client: TestClient) -> None:
    org, user = new_org()
    stored = repair_plan(ShotPlanDraft.model_validate(ASSET_PLAN), None)
    as_org(
        org,
        """INSERT INTO ai.director_plan
             (org_id, video_id, source, status, stage, plan, model, updated_at)
           VALUES (%s, %s, 'seed', 'ready', 'ready', %s, 'seed-model', now())""",
        (org, VIDEO, Jsonb(stored.model_dump(mode="json"))),
    )
    served = plan_of(client, org, user)
    assert served.plan == stored
    assert served.plan is not None
    assert [edit.type for edit in served.plan.edits] == ["layout", "text"]
