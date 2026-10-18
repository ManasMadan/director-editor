"""Pure tests for app/assets.py's helpers: what Nano Banana is asked for, in which shape,
which assets get a default, where each is kept, and which failures are worth a retry."""

from uuid import UUID

import httpx
import pytest
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
from app.branding import unbranding
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


def test_the_creator_s_identity_is_replaced_with_a_placeholder_everywhere() -> None:
    reference = {
        **REFERENCE,
        "composition": "The be10X logo on top, a headline under it",
        "text": ["BE10X", "Claude Automation Expert", "Follow @be10x.official", "be10x.in"],
        "brands": ["be10X"],
    }
    prompt = image_prompt(
        an_asset(
            reference=reference,
            prompt='A white card with the "be10X" logo and "Claude Automation Expert".',
        )
    )
    assert "be10x" not in prompt.lower()
    assert '"Your Name" logo' in prompt
    assert "The Your Name logo on top" in prompt
    assert 'The text "Your Name", spelt exactly like that.' in prompt
    assert 'The text "Follow @yourname", spelt exactly like that.' in prompt
    assert 'The text "yourwebsite.com", spelt exactly like that.' in prompt
    # The Short's topic isn't the creator's identity: it stays.
    assert 'The text "Claude Automation Expert", spelt exactly like that.' in prompt


def test_a_handle_or_web_address_is_caught_even_when_the_planner_lists_no_brands() -> None:
    reference = {**REFERENCE, "text": ["Apply at https://mesa.school/apply", "www.mesa.school"]}
    prompt = image_prompt(an_asset(reference=reference, prompt="An end card, @mesaschool."))
    assert "mesa" not in prompt.lower()
    assert prompt.count("yourwebsite.com") == 2
    assert "An end card, @yourname." in prompt


@pytest.mark.parametrize(
    ("brands", "text", "unbranded"),
    [
        # A brand is a whole word, never letters inside another.
        (["AI"], "Maintain your AI training plan", "Maintain your Your Name training plan"),
        (["Apple"], "Pineapple smoothie", "Pineapple smoothie"),
        (["Mesa"], "Mesaverde, by Mesa", "Mesaverde, by Your Name"),
        (["X"], "Max out 10X", "Max out 10X"),
        # One pass: a placeholder put in is never matched again.
        (["Name", "your"], "@mesaschool", "@yourname"),
        (["Name"], "Name", "Your Name"),
        # Ordinary text isn't a web address, nor an email a handle.
        ([], "e.g.in 2 steps, Node.js, 5.5", "e.g.in 2 steps, Node.js, 5.5"),
        ([], "email me: a@b.com", "email me: a@b.com"),
        # The longest name first.
        (["Mesa", "Mesa School"], "Mesa School rocks", "Your Name rocks"),
    ],
)
def test_unbranding_replaces_only_whole_names_handles_and_addresses(
    brands: list[str], text: str, unbranded: str
) -> None:
    assert unbranding(brands)(text) == unbranded


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
