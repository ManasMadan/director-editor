"""Pure tests for app/assets.py's helpers: what Nano Banana is asked for, in which shape,
which assets get a default, where each is kept, and which failures are worth a retry."""

from uuid import UUID

import httpx
from google.genai import errors as genai_errors

from app.assets import (
    MAX_DEFAULT_ASSETS,
    NoImage,
    asset_key,
    default_assets,
    drawn_aspect_ratio,
    image_prompt,
    worth_retrying,
)
from app.schemas import Asset, ShotPlan
from tests.test_plan_repair_assets import REFERENCE, asset
from tests.test_seed_media import PLAN


def an_asset(**overrides: object) -> Asset:
    return Asset.model_validate(asset(**overrides))


def test_the_prompt_holds_the_image_to_its_reference() -> None:
    prompt = image_prompt(an_asset())
    assert prompt.startswith('A flat black-and-white infographic titled "12 MALE ARCHETYPES".')
    assert "Style: Flat vector infographic. Palette: Black and white." in prompt
    assert "Black and white only, no colour." in prompt
    assert 'The text "12 MALE ARCHETYPES", spelt exactly like that.' in prompt
    assert "not a likeness of any real" in prompt
    assert "No logos, watermarks or brand names" in prompt


def test_a_colour_asset_with_no_text_is_asked_for_as_it_is() -> None:
    no_text: list[str] = []
    reference = {**REFERENCE, "blackAndWhite": False, "palette": "Orange on white", "text": no_text}
    prompt = image_prompt(an_asset(reference=reference))
    assert "Black and white only" not in prompt
    assert "spelt exactly" not in prompt
    assert "Palette: Orange on white." in prompt


def test_half_a_split_screen_is_drawn_in_the_nearest_shape_nano_banana_has() -> None:
    assert drawn_aspect_ratio(an_asset()) == "5:4"
    assert drawn_aspect_ratio(an_asset(reference={**REFERENCE, "aspectRatio": "9:16"})) == "9:16"


def test_stills_get_a_default_in_order_up_to_the_limit() -> None:
    assets = [
        asset(id="music", kind="music"),
        *[asset(id=f"still-{n}") for n in range(MAX_DEFAULT_ASSETS + 1)],
        asset(id="broll", kind="broll"),
    ]
    plan = ShotPlan.model_validate({**PLAN, "assets": assets})
    assert [each.id for each in default_assets(plan)] == [
        f"still-{n}" for n in range(MAX_DEFAULT_ASSETS)
    ]


def test_an_image_is_kept_in_its_plan_s_folder_under_its_asset_s_id() -> None:
    plan_id = UUID("0199f3a0-0000-7000-8000-000000000001")
    assert asset_key(plan_id, "chart", "image/png") == f"director-assets/{plan_id}/chart.png"
    assert asset_key(plan_id, "card", "image/jpeg") == f"director-assets/{plan_id}/card.jpg"


def test_only_an_outage_or_being_told_to_slow_down_is_worth_a_retry() -> None:
    assert worth_retrying(genai_errors.ServerError(503, {"error": {"message": "down"}}))
    assert worth_retrying(genai_errors.ClientError(429, {"error": {"message": "slow"}}))
    assert worth_retrying(httpx.ConnectError("no route"))
    assert not worth_retrying(genai_errors.ClientError(400, {"error": {"message": "bad"}}))
    assert not worth_retrying(NoImage("words only"))
