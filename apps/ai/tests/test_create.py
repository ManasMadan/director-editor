"""Templates a member describes (app/create.py), against real Postgres and Redis, with a
local Gemini API that speaks its real protocol and object storage answering presigned
reads (tests/fakes.py): the brainstorm and its three questions, the plan written from the
brief and photos, the day's limit apart from the one indexed Short, editing, failures,
and the worker's dispatch."""

from collections.abc import Callable, Iterator
from uuid import UUID

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.create import CREATE_PER_DAY, Creator
from app.queues import JobLike
from app.schemas import BrainstormReply, DirectorLibraryOut, DirectorPlanOut
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
from tests.support import as_org, error_of, headers, new_org, on_app_loop, stored_job
from tests.test_director import PLAN, Job, director, insert_plan

pytestmark = pytest.mark.integration

# A JPEG's first bytes, then filler: what the worker stores a brief photo as.
KITCHEN = b"\xff\xd8\xff\xe0" + b"kitchen-counter-with-a-blue-mug" * 8
SHOT: dict[str, object] = {
    "kind": "video",
    "mode": "on-camera",
    "title": "The pour",
    "purpose": "hook: the first coffee of the day, cosy",
    "sourceStartSeconds": 0,
    "sourceEndSeconds": 5,
    "durationSeconds": 5,
    "camera": "back",
    "scene": "Your counter, by the blue mug",
    "sceneLandmark": "mug",
    "framing": {
        "shotSize": "close-up",
        "subject": {"x": 0.2, "y": 0.3, "width": 0.6, "height": 0.4},
        "note": "Just the mug and the pour.",
    },
    "phoneAngle": {"pitch": -30, "roll": 0, "tolerance": 10, "height": "chest"},
    "pose": {"description": "Hands pouring coffee.", "keypoints": []},
    "steps": [{"atSeconds": 0, "instruction": "Pour slowly.", "cameraMove": "static"}],
    "script": [],
}
WRITTEN: dict[str, object] = {
    "title": "Morning coffee",
    "format": "Cosy routine",
    "summary": "Twenty seconds of a cosy morning coffee. No talking, just me, warm light.",
    "audio": "music",
    "durationSeconds": 20,
    "assets": [],
    "edits": [],
    "shots": [
        {
            **SHOT,
            "title": f"Shot {index}",
            "sourceStartSeconds": index * 5,
            "sourceEndSeconds": index * 5 + 5,
        }
        for index in range(4)
    ],
}


@pytest.fixture
def gemini() -> Iterator[tuple[Fake, dict[str, Callable[[bytes], Reply]]]]:
    handlers: dict[str, Callable[[bytes], Reply]] = {
        GEMINI_PATH: gemini_output({"reply": "Cosy, love it. Just you?", "ready": False})
    }
    with serve(handlers) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]]) -> dict[str, str]:
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": gemini[0].url,
    }


@pytest.fixture
def storage() -> Iterator[Fake]:
    with serve_files({"/kitchen.jpg": ("image/jpeg", KITCHEN)}) as fake:
        yield fake


def creator() -> Creator:
    from app.main import services

    found = services().creator
    assert found is not None
    return found


def brief(storage: Fake, *turns: tuple[str, str], photo: str = "/kitchen.jpg") -> dict[str, object]:
    return {
        "text": "Twenty seconds of my morning coffee, cosy, no talking",
        "messages": [{"role": role, "text": text} for role, text in turns],
        "photos": [{"fileId": "0190a000-0000-7000-8000-000000000001", "url": storage.url + photo}],
    }


def brainstorm(
    client: TestClient, org: UUID, user: UUID, body: dict[str, object]
) -> httpx.Response:
    return client.post("/v1/director/brainstorm", json=body, headers=headers(org, user))


def create(client: TestClient, org: UUID, user: UUID, body: dict[str, object]) -> httpx.Response:
    return client.post("/v1/director/created", json=body, headers=headers(org, user))


def created_plan(client: TestClient, org: UUID, user: UUID, storage: Fake) -> DirectorPlanOut:
    response = create(client, org, user, brief(storage))
    assert response.status_code == 201, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def plan_of(client: TestClient, org: UUID, user: UUID, video: str) -> DirectorPlanOut:
    response = client.get(f"/v1/director/plans/{video}", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return DirectorPlanOut.model_validate_json(response.content)


def written(
    client: TestClient,
    gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]],
    storage: Fake,
) -> tuple[UUID, UUID, DirectorPlanOut]:
    org, user = new_org()
    plan = created_plan(client, org, user, storage)
    gemini[1][GEMINI_PATH] = gemini_output(WRITTEN)
    on_app_loop(client, lambda: creator().write(org, plan.id, [storage.url + "/kitchen.jpg"], user))
    return org, user, plan_of(client, org, user, plan.videoId)


def test_director_asks_with_the_photos_in_view_and_counts_its_questions(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    response = brainstorm(client, org, user, brief(storage))
    assert response.status_code == 200, response.text
    reply = BrainstormReply.model_validate_json(response.content)
    assert (reply.reply, reply.ready, reply.questionsLeft) == ("Cosy, love it. Just you?", False, 2)
    # Gemini saw the idea and the photo itself.
    sent = gemini[0].received[-1][1]
    assert b"morning coffee" in sent
    assert sent.count(b"image/jpeg") == 1, sent[:600]
    rows = as_org(org, "SELECT feature FROM ai.usage WHERE org_id = %s", (org,))
    assert {feature for (feature,) in rows} == {"director-create"}


def test_after_three_questions_director_only_wraps_up(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    talk = [
        ("director", "Just you?"),
        ("member", "Just me"),
        ("director", "Music?"),
        ("member", "Yes"),
        ("director", "How long?"),
        ("member", "20 seconds"),
    ]
    response = brainstorm(client, org, user, brief(storage, *talk))
    reply = BrainstormReply.model_validate_json(response.content)
    # The model still wanted to ask: three questions is the most, so it's ready anyway.
    assert (reply.ready, reply.questionsLeft) == (True, 0)
    assert b"Ask nothing more" in gemini[0].received[-1][1]


def test_a_photo_that_cant_be_read_refuses_the_turn(client: TestClient, storage: Fake) -> None:
    org, user = new_org()
    response = brainstorm(client, org, user, brief(storage, photo="/gone.jpg"))
    assert response.status_code == 404
    assert error_of(response).code == "FILE_NOT_FOUND"


def test_a_failed_brainstorm_turn_is_upstream_unavailable(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    gemini[1][GEMINI_PATH] = gemini_error(500, "INTERNAL")
    response = brainstorm(client, org, user, brief(storage))
    assert error_of(response).code == "UPSTREAM_UNAVAILABLE"


def test_a_described_template_is_queued_then_written_from_the_brief_and_photos(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    plan = created_plan(client, org, user, storage)
    assert (plan.source, plan.status, plan.plan) == ("created", "pending", None)
    assert plan.brief is not None
    assert plan.brief.text.startswith("Twenty seconds")
    job = stored_job(f"{{ai-director}}:ai-director:{plan.id}")
    assert job[b"name"] == b"create-plan"
    assert b"/kitchen.jpg" in job[b"data"]

    gemini[1][GEMINI_PATH] = gemini_output(WRITTEN)
    on_app_loop(client, lambda: creator().write(org, plan.id, [storage.url + "/kitchen.jpg"], user))
    ready = plan_of(client, org, user, plan.videoId)
    assert ready.status == "ready"
    assert ready.plan is not None
    assert len(ready.plan.shots) == 4
    assert "No talking" in ready.plan.summary
    assert gemini[0].received[-1][1].count(b"image/jpeg") == 1
    # Running the job again leaves a written plan as it is.
    calls = len(gemini[0].received)
    on_app_loop(client, lambda: creator().write(org, plan.id, [], user))
    assert len(gemini[0].received) == calls


def test_created_templates_have_their_own_limit_apart_from_the_indexed_short(
    client: TestClient, storage: Fake
) -> None:
    org, user = new_org()
    for _ in range(CREATE_PER_DAY):
        assert create(client, org, user, brief(storage)).status_code == 201
    refused = create(client, org, user, brief(storage))
    assert refused.status_code == 429
    assert error_of(refused).code == "DIRECTOR_CREATE_LIMIT"
    assert error_of(refused).data.params == {"limit": CREATE_PER_DAY}
    response = client.get("/v1/director/library", headers=headers(org, user))
    library = DirectorLibraryOut.model_validate_json(response.content)
    # None of them is the member's one indexed Short.
    assert library.indexUsed is False
    assert {plan.source for plan in library.templates} == {"created"}


def test_the_member_edits_their_shots_and_they_are_put_back_to_back(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user, plan = written(client, gemini, storage)
    assert plan.plan is not None
    shots = [shot.model_dump(mode="json") for shot in plan.plan.shots]
    # Shot 3 first, shot 2 deleted, and the first one's place changed.
    edited = {
        **plan.plan.model_dump(mode="json"),
        "shots": [shots[3], {**shots[0], "scene": "At the window"}, shots[2]],
    }
    response = client.put(
        "/v1/director/created",
        json={"videoId": plan.videoId, "plan": edited},
        headers=headers(org, user),
    )
    assert response.status_code == 200, response.text
    saved = DirectorPlanOut.model_validate_json(response.content)
    assert saved.plan is not None
    assert [(s.title, s.sourceStartSeconds) for s in saved.plan.shots] == [
        ("Shot 3", 0),
        ("Shot 0", 5),
        ("Shot 2", 10),
    ]
    assert saved.plan.shots[1].scene == "At the window"
    assert saved.plan.durationSeconds == 15


def test_only_the_member_who_described_it_can_edit_it(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, _user, plan = written(client, gemini, storage)
    assert plan.plan is not None
    other = new_org()[1]
    body = {"videoId": plan.videoId, "plan": plan.plan.model_dump(mode="json")}
    response = client.put("/v1/director/created", json=body, headers=headers(org, other))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_EDITABLE"
    # An indexed or seeded template isn't anyone's to edit this way.
    insert_plan(org, "dQw4w9WgXcQ")
    seed = {"videoId": "dQw4w9WgXcQ", "plan": PLAN}
    response = client.put("/v1/director/created", json=seed, headers=headers(org, _user))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_EDITABLE"
    missing = {"videoId": "AAAAAAAAAAA", "plan": PLAN}
    response = client.put("/v1/director/created", json=missing, headers=headers(org, _user))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_FOUND"


def test_a_template_still_being_written_cant_be_edited(client: TestClient, storage: Fake) -> None:
    org, user = new_org()
    plan = created_plan(client, org, user, storage)
    body = {"videoId": plan.videoId, "plan": PLAN}
    response = client.put("/v1/director/created", json=body, headers=headers(org, user))
    assert error_of(response).code == "DIRECTOR_PLAN_NOT_READY"


def test_a_plan_gemini_cant_write_fails_with_its_own_code(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    plan = created_plan(client, org, user, storage)
    gemini[1][GEMINI_PATH] = gemini_error(400, "INVALID_ARGUMENT")
    # A photo gone since it was checked is left out, never the reason it fails.
    on_app_loop(client, lambda: creator().write(org, plan.id, [storage.url + "/gone.jpg"], user))
    failed = plan_of(client, org, user, plan.videoId)
    assert (failed.status, failed.error) == ("failed", "DIRECTOR_CREATE_FAILED")


def test_the_worker_writes_a_described_template(
    client: TestClient, gemini: tuple[Fake, dict[str, Callable[[bytes], Reply]]], storage: Fake
) -> None:
    org, user = new_org()
    plan = created_plan(client, org, user, storage)
    gemini[1][GEMINI_PATH] = gemini_output(WRITTEN)
    process = director_processor(director(), creator())
    meta = {"requestId": "req-1", "userId": str(user), "orgId": str(org)}
    payload = {
        "planId": str(plan.id),
        "orgId": str(org),
        "photoUrls": [storage.url + "/kitchen.jpg"],
    }
    job: JobLike = Job("create-plan", {"meta": meta, "payload": payload})
    on_app_loop(client, lambda: process(job))
    assert plan_of(client, org, user, plan.videoId).status == "ready"
    # Without a creator (never, beside Director) the job can't run.
    with pytest.raises(RuntimeError):
        on_app_loop(client, lambda: director_processor(director())(job))


def test_a_created_plans_brief_is_stored_with_it(client: TestClient) -> None:
    org, user = new_org()
    [(plan_id,)] = as_org(
        org,
        """INSERT INTO ai.director_plan (org_id, created_by, video_id, source, status, stage,
             plan, brief, updated_at)
           VALUES (%s, %s, 'BBBBBBBBBBB', 'created', 'ready', 'ready', %s, %s, now())
           RETURNING id""",
        (org, user, Jsonb(PLAN), Jsonb({"text": "Coffee", "messages": [], "photos": []})),
    )
    assert isinstance(plan_id, UUID)
    plan = plan_of(client, org, user, "BBBBBBBBBBB")
    assert plan.brief is not None
    assert plan.brief.text == "Coffee"
    assert plan.storyboards == []
