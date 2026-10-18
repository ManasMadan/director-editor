"""Pure tests for what app/plan_repair.py does to a plan's assets and edits: ids the
storage key can carry, timing kept inside the Short, the lists back within their limits,
and every edit turned into its own type's model, or dropped when it can't be made whole.
"""

import pytest

from app.plan_repair import repair_plan
from app.schemas import (
    MAX_ASSET_TEXT_LINES,
    MAX_ASSETS,
    MAX_EDITS,
    EndCardEdit,
    GapEdit,
    GradeEdit,
    LayoutEdit,
    OverlayEdit,
    ShotPlan,
    ShotPlanDraft,
    SpeedEdit,
    TextEdit,
    TransitionEdit,
)
from tests.test_plan_repair import shot

REFERENCE: dict[str, object] = {
    "subject": "A bar chart of twelve thinking archetypes, a small portrait on each row",
    "composition": "Title across the top, twelve rows below, portraits on the left",
    "style": "Flat vector infographic",
    "palette": "Black and white",
    "blackAndWhite": True,
    "aspectRatio": "9:8",
    "text": ["12 MALE ARCHETYPES"],
    "mood": "Bold, curious",
}


def asset(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "chart",
        "kind": "image",
        "title": "The archetypes chart",
        "role": "Explained by the speaker, in the bottom half of a split screen",
        "description": "A static infographic ranking twelve archetypes.",
        "reference": REFERENCE,
        "prompt": 'A flat black-and-white infographic titled "12 MALE ARCHETYPES".',
        "sourceStartSeconds": 0,
        "sourceEndSeconds": 8,
        "defaultSource": "create",
        "personalisable": True,
        "ask": None,
        "secondScreen": False,
    }
    return {**base, **overrides}


BOX: dict[str, object] = {"x": 0.1, "y": 0.5, "width": 0.8, "height": 0.4}


def edit(kind: str, **fields: object) -> dict[str, object]:
    return {"type": kind, "startSeconds": 0, "endSeconds": 8, **fields}


def plan(
    *,
    assets: list[dict[str, object]] | None = None,
    edits: list[dict[str, object]] | None = None,
    shots: list[dict[str, object]] | None = None,
) -> ShotPlanDraft:
    return ShotPlanDraft.model_validate(
        {
            "title": "Your thinking archetype",
            "format": "split-screen explainer",
            "summary": "A speaker explains a chart under them.",
            "audio": "speech",
            "durationSeconds": 10,
            "shots": shots or [shot(sourceStartSeconds=0, sourceEndSeconds=10, durationSeconds=10)],
            "assets": assets or [],
            "edits": edits or [],
        }
    )


def test_a_plan_written_before_assets_and_edits_reads_with_neither() -> None:
    old = ShotPlan.model_validate(plan().model_dump(mode="json", exclude={"assets", "edits"}))
    assert (old.assets, old.edits) == ([], [])


def test_voiceover_and_asset_shots_are_kept() -> None:
    shots = [
        shot(kind="voiceover", sourceStartSeconds=0, sourceEndSeconds=6, durationSeconds=6),
        shot(kind="asset", sourceStartSeconds=6, sourceEndSeconds=8, durationSeconds=2),
    ]
    repaired = repair_plan(plan(shots=shots), video_seconds=None)
    assert [each.kind for each in repaired.shots] == ["voiceover", "asset"]


def test_asset_ids_are_made_into_unique_slugs_and_edits_follow_them() -> None:
    assets = [
        asset(id="The Chart!"),
        asset(id="the chart", sourceStartSeconds=1),
        asset(id="चार्ट", sourceStartSeconds=2),
        asset(id="end card", kind="end-card", sourceStartSeconds=3),
        asset(id="X" * 40, sourceStartSeconds=4),
        asset(id="x" * 40, sourceStartSeconds=5),
    ]
    edits = [
        edit("overlay", assetId="The Chart!", box=BOX),
        edit("end-card", assetId="end card", startSeconds=8, endSeconds=10),
    ]
    repaired = repair_plan(plan(assets=assets, edits=edits), video_seconds=None)

    assert [each.id for each in repaired.assets] == [
        "the-chart",
        "the-chart-2",
        "asset-3",
        "end-card",
        "x" * 40,
        "x" * 38 + "-6",
    ]
    overlay, end_card = repaired.edits
    assert isinstance(overlay, OverlayEdit)
    assert overlay.assetId == "the-chart"
    assert isinstance(end_card, EndCardEdit)
    assert end_card.assetId == "end-card"


def test_an_asset_s_timing_is_kept_inside_the_short() -> None:
    assets = [
        asset(id="late", sourceStartSeconds=4, sourceEndSeconds=90),
        asset(id="backwards", sourceStartSeconds=7, sourceEndSeconds=3),
    ]
    repaired = repair_plan(plan(assets=assets), video_seconds=None)

    timing = {each.id: (each.sourceStartSeconds, each.sourceEndSeconds) for each in repaired.assets}
    # The Short ends where its last shot does (10 s) when the video's length isn't known.
    assert timing == {"late": (4, 10), "backwards": (0, 10)}


def test_an_asset_s_text_and_the_asset_list_are_trimmed_to_their_limits() -> None:
    lines = ["  ", *[f"Line {n}" for n in range(MAX_ASSET_TEXT_LINES + 3)], "x" * 300]
    reference = {**REFERENCE, "text": lines}
    assets = [
        asset(id=f"a{n}", reference=reference, sourceStartSeconds=MAX_ASSETS + 1 - n, ask="  ")
        for n in range(MAX_ASSETS + 2)
    ]
    repaired = repair_plan(plan(assets=assets), video_seconds=60)

    assert len(repaired.assets) == MAX_ASSETS
    # The earliest to appear are kept, in the order they appear.
    assert repaired.assets[0].id == f"a{MAX_ASSETS + 1}"
    assert repaired.assets[0].reference.text == [f"Line {n}" for n in range(MAX_ASSET_TEXT_LINES)]
    assert repaired.assets[0].ask is None


def test_every_edit_type_becomes_its_own_model() -> None:
    edits = [
        edit("layout", layout="split", assetId="chart", cameraShare=0.95),
        edit("layout", layout="picture-in-picture", box=BOX),
        edit("layout", layout="full", assetId="chart", cameraOn="top", box=BOX),
        edit("overlay", mark="circle", color="#ff0000", box=BOX, entry="draw"),
        edit("grade", grade="black-and-white"),
        edit("text", style="captions", text="Ignored", captionStyle=None, color="red"),
        edit("text", style="title", text="  12 archetypes  ", highlightColor="#FFD700"),
        edit("transition", transition="match-cut", anchor=" the cup ", startSeconds=5),
        edit("speed", fromRate=20, toRate=None),
        edit("end-card", text="  "),
        edit("gap", description="B-roll of a bootcamp hall"),
    ]
    repaired = repair_plan(plan(assets=[asset()], edits=edits), video_seconds=None)

    # In order of their start (and end), ties as they came: the match cut starts last.
    split, inset, full, mark, grade, captions, title, speed, end_card, gap, match = (
        repaired.edits
    )
    assert split == LayoutEdit(
        type="layout",
        startSeconds=0,
        endSeconds=8,
        layout="split",
        assetId="chart",
        cameraOn="top",
        cameraShare=0.8,
        box=None,
        inset=None,
    )
    assert isinstance(inset, LayoutEdit)
    assert (inset.layout, inset.inset, inset.cameraOn, inset.cameraShare) == (
        "picture-in-picture",
        "camera",
        None,
        None,
    )
    assert isinstance(full, LayoutEdit)
    assert (full.assetId, full.cameraOn, full.box) == ("chart", None, None)
    assert isinstance(mark, OverlayEdit)
    assert (mark.mark, mark.color, mark.entry, mark.exit) == ("circle", "#ff0000", "draw", "cut")
    assert grade == GradeEdit(
        type="grade", startSeconds=0, endSeconds=8, grade="black-and-white", target="all"
    )
    assert isinstance(captions, TextEdit)
    assert (captions.text, captions.captionStyle, captions.color, captions.position) == (
        None,
        "word-by-word",
        None,
        "bottom",
    )
    assert isinstance(title, TextEdit)
    assert (title.text, title.captionStyle, title.highlightColor) == (
        "12 archetypes",
        None,
        "#FFD700",
    )
    assert isinstance(match, TransitionEdit)
    assert (match.startSeconds, match.anchor) == (5, "the cup")
    assert isinstance(speed, SpeedEdit)
    assert (speed.fromRate, speed.toRate, speed.easing) == (8, 8, "linear")
    assert end_card == EndCardEdit(
        type="end-card", startSeconds=0, endSeconds=8, assetId=None, text=None
    )
    assert isinstance(gap, GapEdit)


@pytest.mark.parametrize(
    "dropped",
    [
        edit("layout"),
        edit("layout", layout="picture-in-picture"),
        edit("overlay", box=BOX),
        edit("overlay", assetId="nowhere", box=BOX),
        edit("overlay", mark="circle"),
        edit("grade"),
        edit("text"),
        edit("text", style="title", text=" "),
        edit("transition"),
        edit("speed"),
        edit("speed", fromRate=1, toRate=1),
        edit("gap", description=" "),
        edit("gap", startSeconds=12, endSeconds=14, description="After the end"),
    ],
)
def test_an_edit_that_can_t_be_made_whole_is_dropped(dropped: dict[str, object]) -> None:
    repaired = repair_plan(plan(edits=[dropped]), video_seconds=None)
    assert repaired.edits == []


def test_an_edit_naming_an_asset_the_plan_hasn_t_keeps_the_rest() -> None:
    edits = [
        edit("layout", layout="split", assetId="nowhere"),
        edit("overlay", assetId="nowhere", mark="arrow", box=BOX),
    ]
    layout, overlay = repair_plan(plan(edits=edits), video_seconds=None).edits
    assert isinstance(layout, LayoutEdit)
    assert layout.assetId is None
    assert isinstance(overlay, OverlayEdit)
    assert (overlay.assetId, overlay.mark) == (None, "arrow")


def test_edits_are_kept_inside_the_short_and_in_order() -> None:
    edits = [
        edit("grade", grade="warm", startSeconds=6, endSeconds=40),
        edit("text", style="captions", startSeconds=0, endSeconds=10),
        # A cut has no length of its own: it gets a short one, inside the Short.
        edit("transition", transition="cut", startSeconds=4, endSeconds=4),
        edit("transition", transition="fade", startSeconds=10, endSeconds=10),
    ]
    repaired = repair_plan(plan(edits=edits), video_seconds=None)
    timing = [(each.type, each.startSeconds, each.endSeconds) for each in repaired.edits]
    assert timing == [
        ("text", 0, 10),
        ("transition", 4, 4.3),
        ("grade", 6, 10),
        ("transition", 9.7, 10),
    ]


def test_edits_are_trimmed_to_their_limit() -> None:
    edits = [edit("gap", description=f"Gap {n}", startSeconds=n / 10) for n in range(MAX_EDITS + 5)]
    repaired = repair_plan(plan(edits=edits), video_seconds=None)
    assert len(repaired.edits) == MAX_EDITS
    assert repaired.edits[-1].startSeconds == (MAX_EDITS - 1) / 10
