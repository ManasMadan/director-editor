"""The picker's slots beyond a plan's assets: a B-roll slot per gap and per shot."""

from app.clips import clip_prompt, veo_address
from app.schemas import GapEdit, ShotPlan
from app.slots import gap_assets, is_gap_slot, slot_assets
from tests.test_seed_media import PLAN


def with_gaps(plan: ShotPlan) -> ShotPlan:
    gap = GapEdit(type="gap", startSeconds=1, endSeconds=2.5, description="A bootcamp hall")
    return plan.model_copy(update={"edits": [*plan.edits, gap]})


def test_every_gap_and_every_shot_gets_a_b_roll_slot_after_the_plan_s_assets() -> None:
    plan = with_gaps(ShotPlan.model_validate(PLAN))
    gaps = gap_assets(plan)
    assert [asset.id for asset in gaps] == [
        "gap-1",
        *(f"shot-{n}" for n in range(1, len(plan.shots) + 1)),
    ]
    first = gaps[0]
    assert first.kind == "broll"
    assert first.defaultSource == "stock"
    assert "A bootcamp hall" in first.prompt
    assert (first.sourceStartSeconds, first.sourceEndSeconds) == (1, 2.5)
    assert all(is_gap_slot(asset) for asset in gaps)
    slots = slot_assets(plan)
    assert slots[: len(plan.assets)] == plan.assets
    assert not any(is_gap_slot(asset) for asset in plan.assets)


def test_a_plan_asset_keeps_its_id_over_a_b_roll_slot_of_the_same_name() -> None:
    plan = with_gaps(ShotPlan.model_validate(PLAN))
    taken = plan.model_copy(
        update={"assets": [gap_assets(plan)[0].model_copy(update={"title": "Mine"})]}
    )
    ids = [asset.id for asset in slot_assets(taken)]
    assert ids.count("gap-1") == 1
    assert slot_assets(taken)[0].title == "Mine"


def test_a_clip_is_asked_for_as_anonymous_vertical_b_roll() -> None:
    prompt = clip_prompt("A crowd at a startup event")
    assert prompt.startswith("A crowd at a startup event")
    assert "9:16" in prompt
    assert "anonymous" in prompt


def test_veo_is_addressed_in_its_own_location_with_the_project() -> None:
    assert (
        veo_address("veo-3.1-lite-generate-001", "my-project", "us-central1")
        == "projects/my-project/locations/us-central1/publishers/google/models/"
        "veo-3.1-lite-generate-001"
    )
    assert veo_address("veo-3.1-lite-generate-001", None, "us-central1") == (
        "veo-3.1-lite-generate-001"
    )
