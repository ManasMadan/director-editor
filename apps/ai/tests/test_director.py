"""Director against real Postgres and Redis, with a local Gemini API that speaks its real
protocol (tests/fakes.py): plans, scene checks, takes and their reviews, budgets, every
way a model call can fail, tenancy, and the worker's dispatch."""

import base64
import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from uuid import UUID, uuid4

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.director import PLANNER_RETRIES, Director, ReviewInterrupted
from app.queues import JobLike
from app.schemas import DirectorPlanOut, DirectorTakeOut, SceneCheck
from app.settings import get_settings
from app.worker import director_processor
from tests.fakes import (
    GEMINI_MODEL,
    GEMINI_PATH,
    Fake,
    Reply,
    gemini_error,
    gemini_output,
    serve,
    serve_files,
)
from tests.support import (
    ENV,
    as_org,
    error_of,
    headers,
    migrator,
    new_org,
    on_app_loop,
    published,
    redis_client,
    stored_job,
    subscribe,
)

pytestmark = pytest.mark.integration

VIDEO = "dQw4w9WgXcQ"
# A real JPEG's first bytes, then filler: the service checks the signature, Gemini (the
# fake) the rest.
FRAME = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 200).decode()

STEP: dict[str, object] = {
    "atSeconds": 0,
    "instruction": "Put on your top.",
    "cameraMove": "static",
}
FRAMING: dict[str, object] = {
    "shotSize": "full-body",
    "subject": {"x": 0.25, "y": 0.1, "width": 0.5, "height": 0.85},
    "note": "Head to toe, centered.",
}
ANGLE: dict[str, object] = {"pitch": 0, "roll": 0, "tolerance": 8, "height": "chest"}
PLAN: dict[str, object] = {
    "title": "Get ready with me",
    "format": "GRWM",
    "summary": "An outfit built piece by piece, then the full look.",
    "audio": "speech-and-music",
    "durationSeconds": 12,
    "shots": [
        {
            "kind": "video",
            "title": "The top",
            "purpose": "Shows the first piece.",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 4,
            "durationSeconds": 4,
            "camera": "back",
            "scene": "In front of a mirror",
            "sceneLandmark": "mirror",
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {
                "description": "Standing, arms relaxed.",
                "keypoints": [{"name": "nose", "x": 0.5, "y": 0.15}],
            },
            "steps": [STEP],
            "script": [{"startSeconds": 0, "endSeconds": 2, "text": "First, the top."}],
        },
        {
            "kind": "photo",
            "title": "The full look",
            "purpose": "The finished outfit, still.",
            "sourceStartSeconds": 10,
            "sourceEndSeconds": 12,
            "durationSeconds": 2,
            "camera": "back",
            "scene": "Anywhere with light",
            "sceneLandmark": None,
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {"description": "Hand on hip.", "keypoints": []},
            "steps": [{**STEP, "instruction": "Strike a pose."}],
            "script": [],
        },
    ],
}
# No one in the shot at all: an object (the pan) is the whole subject.
NO_PERSON_PLAN: dict[str, object] = {
    "title": "5-minute pasta",
    "format": "recipe",
    "summary": "A quick pasta, from pan to plate.",
    "audio": "music",
    "durationSeconds": 6,
    "shots": [
        {
            "kind": "video",
            "title": "The pan",
            "purpose": "setup: the ingredients go in, simple and inviting",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 6,
            "durationSeconds": 6,
            "camera": "back",
            "scene": "At the stove",
            "sceneLandmark": "stove",
            "framing": {
                "shotSize": "close-up",
                "subject": {"x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6},
                "note": "The pan fills the frame.",
            },
            "phoneAngle": {"pitch": -60, "roll": 0, "tolerance": 10, "height": "overhead"},
            "pose": {"description": "No one in frame.", "keypoints": []},
            "steps": [
                {"atSeconds": 0, "instruction": "Put the pan on the stove.", "cameraMove": "static"}
            ],
            "script": [],
        }
    ],
}
# Nobody speaks; the story is told by on-screen captions, carried as script lines.
NO_SPEECH_PLAN: dict[str, object] = {
    "title": "3 tips for faster mornings",
    "format": "listicle",
    "summary": "Three on-screen tips, no voice at all.",
    "audio": "none",
    "durationSeconds": 6,
    "shots": [
        {
            "kind": "video",
            "title": "Tip one",
            "purpose": "hook: the first tip, on screen only",
            "sourceStartSeconds": 0,
            "sourceEndSeconds": 6,
            "durationSeconds": 6,
            "camera": "front",
            "scene": "In the kitchen",
            "sceneLandmark": None,
            "framing": FRAMING,
            "phoneAngle": ANGLE,
            "pose": {
                "description": "Standing, pointing at the caption.",
                "keypoints": [{"name": "nose", "x": 0.5, "y": 0.2}],
            },
            "steps": [
                {
                    "atSeconds": 0,
                    "instruction": 'Show the caption "Tip 1: Prep the night before".',
                    "cameraMove": "static",
                }
            ],
            "script": [
                {"startSeconds": 0, "endSeconds": 3, "text": "Tip 1: Prep the night before"}
            ],
        }
    ],
}
SCENE: dict[str, object] = {
    "inPlace": False,
    "instruction": "Move about five meters left, to the tree.",
    "direction": "left",
    "distanceMeters": 5,
    "landmark": {"label": "tree", "box": {"x": 0.05, "y": 0.2, "width": 0.3, "height": 0.7}},
    "lighting": "good",
}
REVIEW: dict[str, object] = {
    "bestStartSeconds": 1.25,
    "bestEndSeconds": 4.5,
    "score": 82,
    "feedback": "Great framing; hold the last pose a beat longer.",
}

_TAKES = TypeAdapter(list[DirectorTakeOut])


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    """The Gemini API; a test swaps what it answers with through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {GEMINI_PATH: gemini_output(PLAN)}
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]) -> dict[str, str]:
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        # Indexing (app/director.py's planner) uses its own models; the fake only answers
        # one path, so both point at it too, same as DIRECTOR_MODEL.
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }


def director() -> Director:
    from app.main import services

    found = services().director
    assert found is not None
    return found


def plan_of(client: TestClient, org: UUID, user: UUID) -> DirectorPlanOut:
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def request_plan(client: TestClient, org: UUID, user: UUID) -> DirectorPlanOut:
    response = client.post(
        "/v1/director/plans", json={"videoId": VIDEO}, headers=headers(org, user)
    )
    assert response.status_code == 200, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def ready_plan(client: TestClient, org: UUID, user: UUID) -> DirectorPlanOut:
    plan = request_plan(client, org, user)
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    return plan_of(client, org, user)


def new_file(user: UUID, purpose: str = "director-take-video") -> UUID:
    """A ready upload of the user's, as apps/api and the worker would have left it."""
    file_id = uuid4()
    with migrator() as db, db.transaction():
        db.execute("SELECT set_config('app.user_id', %s, true)", (str(user),))
        db.execute(
            """INSERT INTO files.file
                 (id, user_id, purpose, status, filename, declared_type, declared_size, updated_at)
               VALUES (%s, %s, %s, 'ready', 'take', 'video/webm', 10, now())""",
            (file_id, user, purpose),
        )
    return file_id


def add_take(
    client: TestClient,
    org: UUID,
    user: UUID,
    source_url: str,
    *,
    shot: int = 0,
    kind: str = "video",
    content_type: str = "video/webm",
) -> DirectorTakeOut:
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": shot,
            "fileId": str(new_file(user)),
            "kind": kind,
            "contentType": content_type,
            "sourceUrl": source_url,
        },
        headers=headers(org, user),
    )
    assert response.status_code == 201, response.text
    return DirectorTakeOut.model_validate_json(response.content)


def takes_of(client: TestClient, org: UUID, user: UUID) -> list[DirectorTakeOut]:
    response = client.get(f"/v1/director/plans/{VIDEO}/takes", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return _TAKES.validate_json(response.content)


def usage(org: UUID, feature: str) -> int:
    rows = as_org(
        org,
        "SELECT coalesce(sum(input_tokens + output_tokens), 0) FROM ai.usage WHERE feature = %s",
        (feature,),
    )
    [(total,)] = rows
    assert isinstance(total, int)
    return total


def spend_the_month(org: UUID) -> None:
    """Uses up the workspace's monthly allowance (AI_MONTHLY_TOKENS_PER_ORG in the tests)."""
    _ = as_org(
        org,
        "INSERT INTO ai.usage (org_id, feature, model, input_tokens, output_tokens)"
        " VALUES (%s, 'director-plan', 'x', 2000000, 0)",
        (org,),
    )


# ------------------------------------------------------------------------------- plans


def test_requesting_a_plan_queues_its_analysis_once(client: TestClient) -> None:
    org, user = new_org()
    events = subscribe(f"realtime:org:{org}")
    plan = request_plan(client, org, user)
    assert (plan.videoId, plan.status, plan.plan) == (VIDEO, "pending", None)
    job_id = f"{plan.id}-{round(plan.updatedAt.timestamp() * 1000)}"
    job = stored_job(f"{{ai-director}}:ai-director:{job_id}")
    assert job[b"name"] == b"plan"
    assert published(events) == [{"type": "director.changed"}]
    # Asking again, or from another member, changes nothing and queues nothing.
    again = request_plan(client, org, uuid4())
    assert again.id == plan.id
    assert published(events) == []


def test_the_analysis_watches_the_short_and_stores_the_plan(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert plan.status == "ready"
    assert plan.model == GEMINI_MODEL
    assert plan.plan is not None
    assert [shot.kind for shot in plan.plan.shots] == ["video", "photo"]
    [(path, sent)] = gemini[0].received
    assert path == GEMINI_PATH
    # Gemini watches the video from its URL; it is never downloaded here.
    assert b'"file_uri": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"' in sent
    # fps and the resolution hint reach the request (pydantic-ai's VideoUrl.vendor_metadata
    # and GoogleModelSettings.google_video_resolution).
    assert b'"videoMetadata": {"fps": 3.0}' in sent
    assert b'"mediaResolution": "MEDIA_RESOLUTION_MEDIUM"' in sent
    # No array bound anywhere in the schema: Vertex AI answers 400 INVALID_ARGUMENT to a
    # ShotPlan schema that has one (see app/plan_repair.py's module comment).
    assert b"minItems" not in sent
    assert b"maxItems" not in sent
    assert usage(org, "director-plan") == 1_000
    # A ready plan isn't analyzed again, nor queued again when asked for.
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert len(gemini[0].received) == 1
    assert request_plan(client, org, user).status == "ready"


def test_a_plan_with_no_one_in_it_is_accepted(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """An object (a pan, a product, a view) can be the whole subject: empty keypoints and
    an object-framed shot are a valid plan, not a broken one."""
    gemini[1][GEMINI_PATH] = gemini_output(NO_PERSON_PLAN)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert plan.status == "ready"
    assert plan.plan is not None
    [shot] = plan.plan.shots
    assert shot.pose.keypoints == []
    assert shot.camera == "back"


def test_a_plan_with_no_speech_is_accepted(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """Nobody has to speak: on-screen text carrying the story, transcribed into script, is
    a valid plan too."""
    gemini[1][GEMINI_PATH] = gemini_output(NO_SPEECH_PLAN)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert plan.status == "ready"
    assert plan.plan is not None
    assert plan.plan.audio == "none"
    [shot] = plan.plan.shots
    assert [line.text for line in shot.script] == ["Tip 1: Prep the night before"]


def test_the_planner_retries_then_falls_back_to_the_index_fallback_model(
    monkeypatch: pytest.MonkeyPatch, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    """INDEX_MODEL's video calls fail intermittently; a transient failure is retried on it
    a couple of times before the plan falls back to INDEX_FALLBACK_MODEL, rather than
    failing a plan job over one bad response."""
    fallback_model = "gemini-fallback-test"
    fallback_path = f"/v1beta/models/{fallback_model}:generateContent"
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    gemini[1][fallback_path] = gemini_output(PLAN)
    for key, value in {
        **ENV,
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": fallback_model,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()
    redis_client().flushdb()  # pyright: ignore[reportUnknownMemberType]  # untyped options
    from app.main import app

    with TestClient(app) as test_client:
        org, user = new_org()
        plan = ready_plan(test_client, org, user)
    get_settings.cache_clear()

    assert plan.status == "ready"
    paths = [path for path, _ in gemini[0].received]
    # Every attempt on the primary model (the initial try plus PLANNER_RETRIES), then one
    # on the fallback, which is the one that actually answers.
    assert paths.count(GEMINI_PATH) == PLANNER_RETRIES + 1
    assert paths.count(fallback_path) == 1


def test_a_plan_nobody_asked_for_is_not_found(client: TestClient) -> None:
    org, user = new_org()
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(org, user))
    assert (response.status_code, error_of(response).code) == (404, "DIRECTOR_PLAN_NOT_FOUND")
    # And a job for a plan that's gone does nothing.
    on_app_loop(client, lambda: director().analyze(org, uuid4(), user))


def test_another_workspace_never_sees_a_plan(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    other, member = new_org()
    response = client.get(f"/v1/director/plans/{VIDEO}", headers=headers(other, member))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"


def test_a_video_gemini_may_not_watch_fails_without_retrying(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(403, "PERMISSION_DENIED", "The video is private.")
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "DIRECTOR_VIDEO_UNREADABLE")


def test_a_refusal_that_isn_t_about_the_video_is_this_service_s_failure(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(400, "INVALID_ARGUMENT", "API key not valid.")
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "DIRECTOR_ANALYSIS_FAILED")


def test_an_outage_before_the_last_attempt_leaves_the_plan_analyzing_for_the_retry(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    org, user = new_org()
    plan = request_plan(client, org, user)
    with pytest.raises(Exception, match="503"):
        on_app_loop(client, lambda: director().analyze(org, plan.id, user, final=False))
    assert plan_of(client, org, user).status == "analyzing"


def test_an_outage_fails_the_plan_for_a_retry_and_asking_again_requeues_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_error(500, "INTERNAL")
    org, user = new_org()
    plan = request_plan(client, org, user)
    with pytest.raises(Exception, match="500"):
        on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert (plan_of(client, org, user).status, plan_of(client, org, user).error) == (
        "failed",
        "DIRECTOR_ANALYSIS_FAILED",
    )
    retried = request_plan(client, org, user)
    assert (retried.status, retried.error) == ("pending", None)
    job = stored_job(
        f"{{ai-director}}:ai-director:{plan.id}-{round(retried.updatedAt.timestamp() * 1000)}"
    )
    assert job[b"name"] == b"plan"


def test_an_answer_that_breaks_the_plan_s_contract_fails_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_output({"title": "No shots"})
    org, user = new_org()
    plan = request_plan(client, org, user)
    # Not retried: another try would break it the same way, at the same cost.
    on_app_loop(client, lambda: director().analyze(org, plan.id, user))
    assert plan_of(client, org, user).error == "DIRECTOR_ANALYSIS_FAILED"


def test_no_budget_left_fails_the_plan(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    spend_the_month(org)
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "AI_BUDGET_EXCEEDED")
    assert gemini[0].received == []


def test_a_short_that_needs_more_than_a_plan_may_spend_fails_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    gemini[1][GEMINI_PATH] = gemini_output(PLAN, tokens=10_000_000)
    org, user = new_org()
    plan = ready_plan(client, org, user)
    assert (plan.status, plan.error) == ("failed", "DIRECTOR_ANALYSIS_FAILED")
    # What it used is counted all the same.
    assert usage(org, "director-plan") == 10_000_000


# ------------------------------------------------------------------------------- scene checks


def check(
    client: TestClient, org: UUID, user: UUID, shot: int = 0, image: str = FRAME
) -> httpx.Response:
    return client.post(
        "/v1/director/scene-checks",
        json={"videoId": VIDEO, "shotIndex": shot, "image": image},
        headers=headers(org, user),
    )


def test_a_scene_check_says_where_to_go(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(SCENE, tokens=500)
    response = check(client, org, user)
    assert response.status_code == 200, response.text
    scene = SceneCheck.model_validate_json(response.content)
    assert (scene.direction, scene.distanceMeters) == ("left", 5)
    # The frame reaches Gemini inline, with the shot's scene.
    sent = gemini[0].received[-1][1]
    assert b'"mime_type": "image/jpeg"' in sent
    assert b"In front of a mirror" in sent
    assert usage(org, "director-scene") == 500


def test_a_scene_check_needs_a_ready_plan_a_real_shot_and_a_jpeg(client: TestClient) -> None:
    org, user = new_org()
    _ = request_plan(client, org, user)
    assert error_of(check(client, org, user)).code == "DIRECTOR_PLAN_NOT_READY"
    plan_id = plan_of(client, org, user).id
    on_app_loop(client, lambda: director().analyze(org, plan_id, user))
    assert error_of(check(client, org, user, shot=5)).code == "DIRECTOR_SHOT_NOT_FOUND"
    png = base64.b64encode(b"\x89PNG" + b"\x00" * 200).decode()
    assert error_of(check(client, org, user, image=png)).code == "VALIDATION_FAILED"
    assert error_of(check(client, org, user, image="%" * 200)).code == "VALIDATION_FAILED"


def test_a_failed_scene_check_is_an_upstream_failure(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_error(503, "UNAVAILABLE")
    response = check(client, org, user)
    assert (response.status_code, error_of(response).code) == (502, "UPSTREAM_UNAVAILABLE")


def test_a_scene_check_with_no_budget_left_is_refused(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    spend_the_month(org)
    response = check(client, org, user)
    assert (response.status_code, error_of(response).code) == (429, "AI_BUDGET_EXCEEDED")


# ------------------------------------------------------------------------------- takes


def test_a_take_is_reviewed_and_keeps_its_best_part(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW, tokens=4_000)
    events = subscribe(f"realtime:org:{org}")
    with serve_files({"/take.webm": ("video/webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 64)}) as files:
        take = add_take(client, org, user, f"{files.url}/take.webm?X-Amz-Signature=abc")
        assert take.status == "pending"
        job = stored_job(f"{{ai-director}}:ai-director:{take.id}")
        assert job[b"name"] == b"review-take"
        on_app_loop(
            client,
            lambda: director().review(
                org, take.id, f"{files.url}/take.webm?X-Amz-Signature=abc", user
            ),
        )
    [reviewed] = takes_of(client, org, user)
    assert (reviewed.status, reviewed.bestStartMs, reviewed.bestEndMs, reviewed.score) == (
        "ready",
        1_250,
        4_500,
        82,
    )
    assert reviewed.feedback == REVIEW["feedback"]
    assert b'"mime_type": "video/webm"' in gemini[0].received[-1][1]
    assert usage(org, "director-review") == 4_000
    assert {"type": "director.changed"} in published(events)
    # Reviewed once: running the job again leaves it.
    on_app_loop(client, lambda: director().review(org, take.id, "http://unused", user))


def test_a_photo_take_has_no_best_part(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/photo.jpg": ("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 64)}) as files:
        take = add_take(
            client,
            org,
            user,
            f"{files.url}/photo.jpg",
            shot=1,
            kind="photo",
            content_type="image/jpeg",
        )
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/photo.jpg", user))
    [reviewed] = takes_of(client, org, user)
    assert (reviewed.status, reviewed.bestStartMs, reviewed.bestEndMs) == ("ready", None, None)


def test_a_take_needs_a_ready_plan_a_real_shot_and_the_shot_s_kind(client: TestClient) -> None:
    org, user = new_org()
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": 0,
            "fileId": str(new_file(user)),
            "kind": "photo",
            "contentType": "image/jpeg",
            "sourceUrl": "http://storage/x",
        },
        headers=headers(org, user),
    )
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"
    _ = ready_plan(client, org, user)
    response = client.post(
        "/v1/director/takes",
        json={
            "videoId": VIDEO,
            "shotIndex": 0,
            "fileId": str(new_file(user)),
            "kind": "photo",
            "contentType": "image/jpeg",
            "sourceUrl": "http://storage/x",
        },
        headers=headers(org, user),
    )
    assert error_of(response).code == "DIRECTOR_TAKE_KIND_MISMATCH"
    assert takes_of(client, org, user) == []


def test_a_member_only_sees_their_own_takes(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    _ = add_take(client, org, user, "http://storage/take")
    teammate = uuid4()
    with migrator() as db:
        db.execute(
            'INSERT INTO auth."user" (id, name, email, updated_at) VALUES (%s, %s, %s, now())',
            (teammate, "T", f"{teammate}@test.dev"),
        )
    assert takes_of(client, org, teammate) == []
    assert len(takes_of(client, org, user)) == 1


def test_a_take_that_isn_t_in_storage_fails_without_a_retry(client: TestClient) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    with serve_files({}) as files:
        take = add_take(client, org, user, f"{files.url}/gone.webm")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/gone.webm", user))
    [failed] = takes_of(client, org, user)
    assert (failed.status, failed.error) == ("failed", "DIRECTOR_REVIEW_FAILED")


def test_storage_that_can_t_be_reached_is_retried_without_naming_the_url(
    client: TestClient,
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    # Nothing listens on port 9: the connection is refused.
    take = add_take(client, org, user, "http://127.0.0.1:9/take.webm?X-Amz-Signature=secret")
    with pytest.raises(ReviewInterrupted) as interrupted:
        on_app_loop(
            client,
            lambda: director().review(
                org,
                take.id,
                "http://127.0.0.1:9/take.webm?X-Amz-Signature=secret",
                user,
                final=False,
            ),
        )
    assert "secret" not in str(interrupted.value)
    assert interrupted.value.__cause__ is None
    assert takes_of(client, org, user)[0].status == "reviewing"


@pytest.mark.parametrize(
    ("content_type", "data", "why"),
    [
        ("text/html", b"<html>", "not a take's type"),
        ("video/webm", b"\x00" * 16_000_001, "larger than an upload"),
    ],
    ids=["not a take", "too large"],
)
def test_something_that_isn_t_a_take_isn_t_reviewed(
    client: TestClient, content_type: str, data: bytes, why: str
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    with serve_files({"/x": (content_type, data)}) as files:
        take = add_take(client, org, user, f"{files.url}/x")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/x", user))
    assert takes_of(client, org, user)[0].status == "failed", why


def test_a_review_gemini_can_t_give_fails_for_a_retry(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_error(500, "INTERNAL")
    with serve_files({"/t": ("video/mp4", b"\x00\x00\x00\x18ftypmp42")}) as files:
        take = add_take(client, org, user, f"{files.url}/t", content_type="video/mp4")
        with pytest.raises(ReviewInterrupted):
            on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/t", user))
    assert takes_of(client, org, user)[0].error == "DIRECTOR_REVIEW_FAILED"


def test_a_review_over_its_token_cap_or_the_budget_fails_without_retrying(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    _ = ready_plan(client, org, user)
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW, tokens=10_000_000)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, take.id, f"{files.url}/t", user))
        assert takes_of(client, org, user)[0].error == "DIRECTOR_REVIEW_FAILED"
        # The cap's overrun used up the month: the next review isn't started.
        broke = add_take(client, org, user, f"{files.url}/t")
        on_app_loop(client, lambda: director().review(org, broke.id, f"{files.url}/t", user))
    assert takes_of(client, org, user)[0].error == "AI_BUDGET_EXCEEDED"


def test_a_review_for_a_take_that_s_gone_does_nothing(client: TestClient) -> None:
    org, user = new_org()
    on_app_loop(client, lambda: director().review(org, uuid4(), "http://unused", user))


# ------------------------------------------------------------------------------- the worker


class Job:
    def __init__(self, name: str, data: object) -> None:
        self.id: str | None = "job-1"
        self.name = name
        self.data = data
        self.attemptsMade = 0


def test_the_worker_runs_both_director_jobs(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]
) -> None:
    org, user = new_org()
    plan = request_plan(client, org, user)
    process = director_processor(director())
    meta = {"requestId": "req-1", "userId": str(user), "orgId": str(org)}
    job: JobLike = Job(
        "plan", {"meta": meta, "payload": {"planId": str(plan.id), "orgId": str(org)}}
    )
    on_app_loop(client, lambda: process(job))
    assert plan_of(client, org, user).status == "ready"
    gemini[1][GEMINI_PATH] = gemini_output(REVIEW)
    with serve_files({"/t": ("video/webm", b"\x1a\x45\xdf\xa3")}) as files:
        take = add_take(client, org, user, f"{files.url}/t")
        review: JobLike = Job(
            "review-take",
            {
                "meta": {"orgId": str(org)},
                "payload": {
                    "takeId": str(take.id),
                    "orgId": str(org),
                    "sourceUrl": f"{files.url}/t",
                },
            },
        )
        on_app_loop(client, lambda: process(review))
    assert takes_of(client, org, user)[0].status == "ready"
    with pytest.raises(ValidationError):
        on_app_loop(client, lambda: process(Job("unknown", {})))


def test_the_worker_process_plans_queued_shorts(
    client: TestClient, extra_env: dict[str, str]
) -> None:
    org, user = new_org()
    plan = request_plan(client, org, user)
    worker = subprocess.Popen(
        [sys.executable, "-m", "app.worker"], env={**os.environ, **ENV, **extra_env}
    )
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and plan.status != "ready":
            time.sleep(0.2)
            plan = plan_of(client, org, user)
        assert plan.status == "ready"
    finally:
        worker.terminate()
        assert worker.wait(timeout=10) == 0
