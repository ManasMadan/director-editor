"""Every slot of a plan the asset picker fills: the plan's own assets, then one B-roll slot
per `gap` edit (`gap-<n>`, the nth gap from 1) and one per shot (`shot-<n>`) for when the
member skips it. The editor fills a gap or a skipped shot through the same picker, with
stock, an image drawn for it, or a Veo clip (spec 8.7); the web app names the slots the
same way (apps/web lib/scene.ts).
"""

from app.schemas import MAX_SHORT_SECONDS, Asset, AssetReference, GapEdit, ShotPlan

_GAP_PROMPT = (
    "A photo-real vertical 9:16 B-roll shot for a short video: {what}. Natural light, "
    "real people only as anonymous figures, no text, no logos."
)


def _broll(asset_id: str, title: str, what: str, start: float, end: float) -> Asset:
    return Asset(
        id=asset_id,
        kind="broll",
        title=title[:80],
        role="B-roll the editor cuts to",
        description=what[:600],
        prompt=_GAP_PROMPT.format(what=what)[:1_500],
        sourceStartSeconds=start,
        sourceEndSeconds=min(max(end, start + 0.1), MAX_SHORT_SECONDS),
        defaultSource="stock",
        personalisable=False,
        ask=None,
        secondScreen=False,
        reference=AssetReference(
            subject=what[:240],
            composition="Vertical 9:16, the subject filling the frame",
            style="Photo-real B-roll",
            palette="Natural",
            blackAndWhite=False,
            aspectRatio="9:16",
            text=[],
            mood="Matches the video",
        ),
    )


def gap_assets(plan: ShotPlan) -> list[Asset]:
    """The plan's B-roll slots: each gap edit, then each shot (filled when it's skipped)."""
    gaps = [edit for edit in plan.edits if isinstance(edit, GapEdit)]
    return [
        _broll(f"gap-{n}", edit.description, edit.description, edit.startSeconds, edit.endSeconds)
        for n, edit in enumerate(gaps, start=1)
    ] + [
        _broll(
            f"shot-{n}",
            shot.title,
            f"{shot.title}. {shot.scene}",
            shot.sourceStartSeconds,
            shot.sourceEndSeconds,
        )
        for n, shot in enumerate(plan.shots, start=1)
    ]


def slot_assets(plan: ShotPlan) -> list[Asset]:
    """Every slot the picker fills: the plan's assets, then its B-roll slots (one the plan
    already has an asset by that id for is the plan's)."""
    taken = {asset.id for asset in plan.assets}
    return [*plan.assets, *(asset for asset in gap_assets(plan) if asset.id not in taken)]


def is_gap_slot(asset: Asset) -> bool:
    return asset.id.startswith(("gap-", "shot-")) and asset.kind == "broll"
