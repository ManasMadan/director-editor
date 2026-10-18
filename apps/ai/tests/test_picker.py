"""The asset picker against real Postgres and Redis, with the local stand-ins for Gemini
(Nano Banana and the proofreader) and Cloud Storage (tests/fakes.py): a slot's images
and choices, drawing from a prompt, editing, the limits, uploads and stock pictures,
their credits in the post, and that a member's images are theirs."""

from collections.abc import Callable, Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.picker import IMAGES_PER_DEMO_VIDEO, IMAGES_PER_VIDEO, stock_credit_line
from app.schemas import AssetSlotsOut, StockCredit
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
    gemini_image,
    gemini_output,
    serve,
)
from tests.support import headers, new_org, on_app_loop
from tests.test_assets import ASSET_PLAN, PNG, drawings, images, indexed, make
from tests.test_director import VIDEO, director, fake_yt_dlp

pytestmark = pytest.mark.integration

PROMPT = 'A bold bar chart titled "12 types of coffee drinkers".'
CREDIT = {
    "provider": "pexels",
    "author": "Jane Doe",
    "authorUrl": "https://www.pexels.com/@jane",
    "pageUrl": "https://www.pexels.com/photo/1/",
}

Google = tuple[Fake, dict[str, Callable[[bytes], Reply]]]
# What Cloud Storage's stand-in holds to read back (an image to edit, a reference photo).
STORED: dict[str, tuple[str, bytes]] = {}


@pytest.fixture
def google() -> Iterator[Google]:
    """Gemini (the planner, Nano Banana and the proofreader) and Cloud Storage, on one
    server; a test swaps what each answers with through the dict."""
    handlers: dict[str, Callable[[bytes], Reply]] = {
        GEMINI_PATH: gemini_output(ASSET_PLAN),
        ASSET_PATH: gemini_image(PNG),
        GCS_UPLOAD: gcs_uploaded,
    }
    STORED.clear()
    with serve(handlers, STORED) as fake:
        yield fake, handlers


@pytest.fixture
def extra_env(google: Google, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    monkeypatch.setenv("PATH", fake_yt_dlp(tmp_path, exit_code=1))
    monkeypatch.setenv("STORAGE_EMULATOR_HOST", google[0].url)
    return {
        "DIRECTOR_MODEL": GEMINI_MODEL,
        "INDEX_MODEL": GEMINI_MODEL,
        "INDEX_FALLBACK_MODEL": GEMINI_MODEL,
        "GOOGLE_API_KEY": "test-key",
        "GOOGLE_BASE_URL": google[0].url,
        "MEDIA_BUCKET": MEDIA_BUCKET,
        "ASSET_MODEL": ASSET_MODEL,
    }


def slots(client: TestClient, org: UUID, user: UUID) -> AssetSlotsOut:
    response = client.get(f"/v1/director/plans/{VIDEO}/assets", headers=headers(org, user))
    assert response.status_code == 200, response.text
    return AssetSlotsOut.model_validate_json(response.content)


def draw(
    client: TestClient, org: UUID, user: UUID, asset: str = "chart", **body: object
) -> dict[str, object]:
    response = client.post(
        f"/v1/director/plans/{VIDEO}/assets/{asset}/drawings",
        json={
            "prompt": PROMPT,
            "instruction": None,
            "baseId": None,
            "referenceKey": None,
            "demo": False,
            **body,
        },
        headers=headers(org, user),
    )
    return {**response.json(), "http": response.status_code}


def add(client: TestClient, org: UUID, user: UUID, **body: object) -> dict[str, object]:
    response = client.post(
        f"/v1/director/plans/{VIDEO}/assets/chart/images",
        json={"fileId": None, "credit": None, **body},
        headers=headers(org, user),
    )
    return {**response.json(), "http": response.status_code}


def choose(client: TestClient, org: UUID, user: UUID, candidate: object) -> int:
    response = client.post(
        f"/v1/director/plans/{VIDEO}/assets/chart/choice",
        json={"candidateId": candidate},
        headers=headers(org, user),
    )
    return response.status_code


@pytest.fixture
def ready(client: TestClient) -> tuple[UUID, UUID, UUID]:
    """A workspace with the asset Short indexed and its defaults drawn (and stored)."""
    org, user = new_org()
    plan_id = indexed(client, org, user)
    make(client, org, plan_id)
    STORED[f"director-assets/{plan_id}/chart.png"] = ("image/png", PNG)
    return org, user, plan_id


def test_a_slot_starts_from_the_original_s_reference(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, _ = ready
    got = slots(client, org, user)
    # The plan's own assets, then a B-roll slot per shot, for when the member skips it.
    assert [slot.assetId for slot in got.slots] == [
        "chart",
        "card",
        "music",
        "end-card",
        "shot-1",
        "shot-2",
    ]
    chart = got.slots[0]
    assert chart.prompt.startswith('A flat black-and-white infographic titled "12 MALE')
    assert "Style: Flat vector infographic" in chart.prompt
    assert "Black and white only" in chart.prompt
    # Its default is listed, and nothing is chosen yet.
    assert [(each.origin, each.status) for each in chart.candidates] == [("default", "ready")]
    assert (chart.chosenId, chart.history) == (None, [])
    # The defaults the member indexed count against their images for the video.
    assert (got.imagesUsed, got.imagesPerVideo, got.imagesToday) == (3, IMAGES_PER_VIDEO, 3)


def test_an_image_is_drawn_from_the_member_s_prompt_and_proofread(
    client: TestClient, ready: tuple[UUID, UUID, UUID], google: Google
) -> None:
    org, user, plan_id = ready
    google[1][GEMINI_PATH] = gemini_output({"readsRight": True, "misspelt": []})
    queued = draw(client, org, user)
    assert (queued["http"], queued["origin"], queued["status"]) == (201, "created", "pending")
    before = len(drawings(google[0]))
    make(client, org, plan_id)
    [sent] = drawings(google[0])[before:]
    assert b"12 types of coffee drinkers" in sent
    assert b"not a likeness" in sent
    [mine] = [c for c in slots(client, org, user).slots[0].candidates if c.origin == "created"]
    assert mine.status == "ready"
    assert mine.objectKey == f"director-assets/{plan_id}/chart/{mine.id}.png"
    assert mine.prompt == PROMPT


def test_a_misspelt_image_is_drawn_once_more(
    client: TestClient, ready: tuple[UUID, UUID, UUID], google: Google
) -> None:
    org, user, plan_id = ready
    google[1][GEMINI_PATH] = gemini_output({"readsRight": False, "misspelt": ["cofee"]})
    _ = draw(client, org, user)
    before = len(drawings(google[0]))
    make(client, org, plan_id)
    first, second = drawings(google[0])[before:]
    assert b"Spell every word" not in first
    assert b'Spell every word of the text exactly as quoted: \\"12 types of coffee' in second


def test_an_edit_draws_from_the_image_it_changes(
    client: TestClient, ready: tuple[UUID, UUID, UUID], google: Google
) -> None:
    org, user, plan_id = ready
    default = slots(client, org, user).slots[0].candidates[0]
    edited = draw(client, org, user, baseId=str(default.id), instruction="make it moodier")
    assert edited["http"] == 201
    assert edited["prompt"] == "make it moodier"
    before = len(drawings(google[0]))
    make(client, org, plan_id)
    [sent] = drawings(google[0])[before:]
    assert b"Edit this image: make it moodier" in sent
    # The image it edits goes with it, read back from storage.
    assert b"inlineData" in sent or b"inline_data" in sent
    mine = [c for c in slots(client, org, user).slots[0].candidates if c.origin == "created"]
    assert [c.status for c in mine] == ["ready"]
    # An image that isn't one of the slot's can't be edited.
    other = draw(client, org, user, asset="card", baseId=str(default.id), instruction="x")
    assert (other["http"], other["code"]) == (404, "DIRECTOR_ASSET_NOT_FOUND")


def test_drawing_stops_at_the_video_s_limit_and_the_demo_s(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, _ = ready
    # Three defaults already count; the demo's five leave two.
    assert [draw(client, org, user, demo=True)["http"] for _ in range(3)] == [201, 201, 429]
    assert draw(client, org, user, demo=True)["code"] == "DIRECTOR_IMAGE_LIMIT"
    left = IMAGES_PER_VIDEO - IMAGES_PER_DEMO_VIDEO
    assert {draw(client, org, user)["http"] for _ in range(left)} == {201}
    assert draw(client, org, user)["code"] == "DIRECTOR_IMAGE_LIMIT"
    assert slots(client, org, user).imagesUsed == IMAGES_PER_VIDEO


def test_only_stills_can_be_drawn(client: TestClient, ready: tuple[UUID, UUID, UUID]) -> None:
    org, user, _ = ready
    refused = draw(client, org, user, asset="music")
    assert (refused["http"], refused["code"]) == (404, "DIRECTOR_ASSET_NOT_FOUND")
    assert draw(client, org, user, asset="nothing")["http"] == 404


def test_uploads_and_stock_are_kept_and_chosen_with_their_history(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, plan_id = ready
    file_id = uuid4()
    upload = add(
        client, org, user, origin="upload", objectKey=f"files/{file_id}", fileId=str(file_id)
    )
    assert (upload["http"], upload["origin"], upload["fileId"]) == (201, "upload", str(file_id))
    key = f"director-assets/{plan_id}/chart/{uuid4()}.jpg"
    stock = add(client, org, user, origin="stock", objectKey=key, credit=CREDIT)
    assert stock["credit"] == CREDIT

    assert choose(client, org, user, upload["id"]) == 204
    assert choose(client, org, user, stock["id"]) == 204
    chart = slots(client, org, user).slots[0]
    assert chart.chosenId == UUID(str(stock["id"]))
    assert chart.history == [UUID(str(upload["id"]))]
    # Back to the default.
    assert choose(client, org, user, None) == 204
    assert slots(client, org, user).slots[0].history[0] == UUID(str(stock["id"]))
    # Uploads and stock cost no drawing.
    assert slots(client, org, user).imagesUsed == 3


def test_a_post_credits_each_stock_picture_the_video_uses(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, plan_id = ready
    key = f"director-assets/{plan_id}/chart/{uuid4()}.jpg"
    stock = add(client, org, user, origin="stock", objectKey=key, credit=CREDIT)
    assert choose(client, org, user, stock["id"]) == 204
    lines = on_app_loop(client, lambda: director().picker.stock_credits(org, user, plan_id))
    assert lines == ["The chart: Jane Doe on Pexels (https://www.pexels.com/photo/1/)"]
    # Another member's choice is theirs.
    _, other = new_org()
    assert on_app_loop(client, lambda: director().picker.stock_credits(org, other, plan_id)) == []


def test_a_member_s_own_images_are_theirs(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, _ = ready
    mine = draw(client, org, user)
    _, stranger = new_org()
    theirs = slots(client, org, stranger).slots[0].candidates
    assert [c.origin for c in theirs] == ["default"]
    assert choose(client, org, stranger, mine["id"]) == 404
    # Another workspace has no such plan.
    elsewhere, someone = new_org()
    assert (
        client.get(
            f"/v1/director/plans/{VIDEO}/assets", headers=headers(elsewhere, someone)
        ).status_code
        == 404
    )


def test_a_slot_s_image_that_isn_t_ready_can_t_be_chosen(
    client: TestClient, ready: tuple[UUID, UUID, UUID]
) -> None:
    org, user, plan_id = ready
    pending = draw(client, org, user)
    assert choose(client, org, user, pending["id"]) == 404
    make(client, org, plan_id)
    assert choose(client, org, user, pending["id"]) == 204
    assert [row[1] for row in images(org, plan_id)][-1] == "ready"


def test_the_credit_line_names_the_creator_and_the_source() -> None:
    credit = StockCredit.model_validate({**CREDIT, "provider": "pixabay"})
    assert stock_credit_line("B-roll", credit) == (
        "B-roll: Jane Doe on Pixabay (https://www.pexels.com/photo/1/)"
    )
