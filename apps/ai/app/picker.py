"""The asset picker: every asset slot of a plan offers the member three sources beside its
default image (app/assets.py), and remembers which one they use.

- Create with AI: an image drawn from the member's prompt (the Create tab starts from
  `picker_prompt`, the asset's prompt held to its reference), optionally from a photo of
  theirs (image to image), or an edit of another of the slot's images by a sentence.
  Each is a row of ai.director_asset (origin `created`) drawn by the same `assets` job
  as the defaults, so it's reserved and settled in the usage ledger, proofread for its
  text, and announced with `director.changed` when it lands. Within the spec's limits:
  12 images a video (5 for a demo guest), the plan's defaults the member indexed
  included, and 30 a day across every workspace (ai.images_today).
- Upload and Stock: apps/api checks an upload (the files pipeline) or copies a stock
  picture into storage, then records it here (origin `upload` or `stock`, ready at once,
  a stock one with its credit).

A member's own images are theirs: the slot lists its default and the caller's own, never
another member's. A choice is a row of ai.director_asset_choice; the newest wins, and
the ones before it are the slot's history, which undo walks back through.
"""

from dataclasses import dataclass
from uuid import UUID

from redis.asyncio import Redis
from sqlalchemy import Integer, func, or_, select, type_coerce
from sqlalchemy.ext.asyncio import AsyncSession

from app.assets import (
    CHANGED,
    IMAGES_PER_MEMBER_PER_DAY,
    STILL_KINDS,
    images_lock_key,
    picker_prompt,
)
from app.db.models import DirectorAsset, DirectorAssetChoice, DirectorPlan
from app.db.session import tenant
from app.errors import AppError
from app.queues import DirectorQueue
from app.realtime import publish_to_org
from app.schemas import (
    AssetCandidateCreate,
    AssetCandidateOut,
    AssetChoiceCreate,
    AssetDrawingCreate,
    AssetSlotOut,
    AssetSlotsOut,
    ShotPlan,
    StockCredit,
)
from app.slots import is_gap_slot, slot_assets

# Images drawn for one member in one video: their own and the plan's defaults they
# indexed (spec 8.8). A demo guest gets fewer.
IMAGES_PER_VIDEO = 12
IMAGES_PER_DEMO_VIDEO = 5
# A slot's history, newest first, as far back as undo goes.
HISTORY_LENGTH = 10
# Veo clips for gaps, a member's in one video: by far the dearest piece (spec 8.8).
CLIPS_PER_VIDEO = 3
_DRAWN = ("default", "created")


@dataclass(frozen=True)
class _Plan:
    id: UUID
    plan: ShotPlan


def candidate_out(row: DirectorAsset) -> AssetCandidateOut:
    return AssetCandidateOut(
        id=row.id,
        assetId=row.asset_id,
        origin=row.origin,
        status=row.status,
        objectKey=row.object_key,
        fileId=row.file_id,
        error=row.error,
        prompt=row.prompt,
        credit=StockCredit.model_validate(row.credit) if row.credit is not None else None,
        createdAt=row.created_at,
    )


def stock_credit_line(title: str, credit: StockCredit) -> str:
    """One stock picture's credit for the YouTube description (the providers ask for the
    creator and the source to be named, with a link)."""
    provider = {"pexels": "Pexels", "pixabay": "Pixabay"}[credit.provider]
    return f"{title}: {credit.author} on {provider} ({credit.pageUrl})"


class AssetPicker:
    def __init__(
        self, queue: DirectorQueue, redis: Redis, *, drawing: bool, clip_model: str | None = None
    ) -> None:
        # Drawing needs the assets job's bucket (MEDIA_BUCKET); uploads and stock don't.
        # Clips need Veo too (VEO_MODEL); without it a gap's Create tab draws stills.
        self._queue = queue
        self._redis = redis
        self._drawing = drawing
        self._clip_model = clip_model

    async def slots(self, org_id: UUID, user_id: UUID, video_id: str) -> AssetSlotsOut:
        """Every asset slot of the plan with its images (the default and the caller's
        own, oldest first), the image it uses and its history, and the caller's images
        used and left."""
        async with tenant(org_id) as session:
            plan = await _ready_plan(session, org_id, video_id)
            rows = list(
                await session.scalars(
                    select(DirectorAsset)
                    .where(
                        DirectorAsset.plan_id == plan.id,
                        or_(DirectorAsset.origin == "default", DirectorAsset.user_id == user_id),
                    )
                    .order_by(DirectorAsset.id)
                )
            )
            choices = list(
                await session.scalars(
                    select(DirectorAssetChoice)
                    .where(
                        DirectorAssetChoice.plan_id == plan.id,
                        DirectorAssetChoice.user_id == user_id,
                    )
                    .order_by(DirectorAssetChoice.id.desc())
                )
            )
            used = await _drawn_in_video(session, plan.id, user_id)
            today = await _drawn_today(session, user_id)
        slots = [
            AssetSlotOut(
                assetId=asset.id,
                prompt=picker_prompt(asset),
                candidates=[candidate_out(row) for row in rows if row.asset_id == asset.id],
                chosenId=next((c.candidate_id for c in choices if c.asset_id == asset.id), None),
                history=[c.candidate_id for c in choices if c.asset_id == asset.id][
                    1 : HISTORY_LENGTH + 1
                ],
            )
            for asset in slot_assets(plan.plan)
        ]
        return AssetSlotsOut(
            slots=slots,
            imagesUsed=used,
            imagesPerVideo=IMAGES_PER_VIDEO,
            imagesToday=today,
            imagesPerDay=IMAGES_PER_MEMBER_PER_DAY,
        )

    async def draw(
        self, org_id: UUID, user_id: UUID, video_id: str, asset_id: str, body: AssetDrawingCreate
    ) -> AssetCandidateOut:
        """Queues an image for the slot, drawn from the caller's prompt (and photo), or an
        edit of another of the slot's images; DIRECTOR_IMAGE_LIMIT past the caller's
        images for the video or the day."""
        if not self._drawing:
            raise AppError("FEATURE_DISABLED", {"feature": "director-assets"})
        async with tenant(org_id) as session:
            plan = await _ready_plan(session, org_id, video_id)
            asset = next((a for a in slot_assets(plan.plan) if a.id == asset_id), None)
            # A still for an asset, or a still or a Veo clip for a gap (spec 8.7).
            gap = asset is not None and is_gap_slot(asset)
            if asset is None or (asset.kind not in STILL_KINDS and not gap):
                raise AppError("DIRECTOR_ASSET_NOT_FOUND")
            if body.clip and (not gap or self._clip_model is None or body.baseId is not None):
                raise AppError("DIRECTOR_ASSET_NOT_FOUND")
            if body.baseId is not None:
                await _slot_image(session, plan.id, user_id, asset_id, body.baseId)
            # The member's drawings take turns with their other claims (the defaults
            # included), so two at once can't both pass the limit.
            await session.execute(
                select(
                    func.pg_advisory_xact_lock(func.hashtextextended(images_lock_key(user_id), 0))
                )
            )
            per_video = IMAGES_PER_DEMO_VIDEO if body.demo else IMAGES_PER_VIDEO
            if (
                await _drawn_in_video(session, plan.id, user_id) >= per_video
                or await _drawn_today(session, user_id) >= IMAGES_PER_MEMBER_PER_DAY
            ):
                raise AppError("DIRECTOR_IMAGE_LIMIT")
            if body.clip and (
                body.demo
                or await _clips_in_video(session, plan.id, user_id, self._clip_model)
                >= CLIPS_PER_VIDEO
            ):
                raise AppError("DIRECTOR_IMAGE_LIMIT")
            row = DirectorAsset(
                org_id=org_id,
                plan_id=plan.id,
                user_id=user_id,
                asset_id=asset_id,
                origin="created",
                prompt=body.instruction if body.baseId is not None else body.prompt,
                reference_key=body.referenceKey,
                base_id=body.baseId,
                # A clip is made by Veo: the row names its model from the start, which
                # is how the assets job knows to make a clip of it (app/clips.py).
                model=self._clip_model if body.clip else None,
                updated_at=func.now(),
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            out = candidate_out(row)
        await self._queue.add_assets(
            plan.id, org_id, job_id=f"{plan.id}-assets-{out.id}", request_id=None, user_id=user_id
        )
        await publish_to_org(self._redis, org_id, CHANGED)
        return out

    async def add(
        self,
        org_id: UUID,
        user_id: UUID,
        video_id: str,
        asset_id: str,
        body: AssetCandidateCreate,
    ) -> AssetCandidateOut:
        """Records an image apps/api has checked and stored for the slot: the caller's
        upload, or a stock picture with its credit."""
        async with tenant(org_id) as session:
            plan = await _ready_plan(session, org_id, video_id)
            if not any(asset.id == asset_id for asset in slot_assets(plan.plan)):
                raise AppError("DIRECTOR_ASSET_NOT_FOUND")
            row = DirectorAsset(
                org_id=org_id,
                plan_id=plan.id,
                user_id=user_id,
                asset_id=asset_id,
                origin=body.origin,
                status="ready",
                object_key=body.objectKey,
                file_id=body.fileId,
                credit=body.credit.model_dump() if body.credit is not None else None,
                updated_at=func.now(),
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            out = candidate_out(row)
        await publish_to_org(self._redis, org_id, CHANGED)
        return out

    async def choose(
        self, org_id: UUID, user_id: UUID, video_id: str, asset_id: str, body: AssetChoiceCreate
    ) -> None:
        """Makes one of the slot's ready images the one the caller's video uses (none:
        its default); the one before stays in the slot's history."""
        async with tenant(org_id) as session:
            plan = await _ready_plan(session, org_id, video_id)
            if not any(asset.id == asset_id for asset in slot_assets(plan.plan)):
                raise AppError("DIRECTOR_ASSET_NOT_FOUND")
            if body.candidateId is not None:
                row = await _slot_image(session, plan.id, user_id, asset_id, body.candidateId)
                if row.status != "ready":
                    raise AppError("DIRECTOR_ASSET_NOT_FOUND")
            session.add(
                DirectorAssetChoice(
                    org_id=org_id,
                    plan_id=plan.id,
                    user_id=user_id,
                    asset_id=asset_id,
                    candidate_id=body.candidateId,
                )
            )
        await publish_to_org(self._redis, org_id, CHANGED)

    async def stock_credits(self, org_id: UUID, user_id: UUID, plan_id: UUID) -> list[str]:
        """A credit line for each stock picture the caller's video of the plan uses, in
        the plan's order of assets."""
        async with tenant(org_id) as session:
            plan = await session.get(DirectorPlan, plan_id)
            choices = list(
                await session.scalars(
                    select(DirectorAssetChoice)
                    .where(
                        DirectorAssetChoice.plan_id == plan_id,
                        DirectorAssetChoice.user_id == user_id,
                    )
                    .order_by(DirectorAssetChoice.id.desc())
                )
            )
            chosen: dict[str, UUID | None] = {}
            for choice in choices:
                _ = chosen.setdefault(choice.asset_id, choice.candidate_id)
            ids = [candidate for candidate in chosen.values() if candidate is not None]
            stock = {
                row.asset_id: row
                for row in await session.scalars(
                    select(DirectorAsset).where(
                        DirectorAsset.id.in_(ids), DirectorAsset.origin == "stock"
                    )
                )
            }
        if plan is None or plan.plan is None:
            return []
        return [
            stock_credit_line(asset.title, StockCredit.model_validate(row.credit))
            for asset in slot_assets(ShotPlan.model_validate(plan.plan))
            if (row := stock.get(asset.id)) is not None and row.credit is not None
        ]


async def _ready_plan(session: AsyncSession, org_id: UUID, video_id: str) -> _Plan:
    plan = await session.scalar(
        select(DirectorPlan).where(DirectorPlan.org_id == org_id, DirectorPlan.video_id == video_id)
    )
    if plan is None:
        raise AppError("DIRECTOR_PLAN_NOT_FOUND")
    if plan.status != "ready" or plan.plan is None:
        raise AppError("DIRECTOR_PLAN_NOT_READY")
    return _Plan(plan.id, ShotPlan.model_validate(plan.plan))


async def _slot_image(
    session: AsyncSession, plan_id: UUID, user_id: UUID, asset_id: str, row_id: UUID
) -> DirectorAsset:
    """One of the slot's images the caller may use: its default or one of their own."""
    row = await session.get(DirectorAsset, row_id)
    if (
        row is None
        or row.plan_id != plan_id
        or row.asset_id != asset_id
        or (row.origin != "default" and row.user_id != user_id)
    ):
        raise AppError("DIRECTOR_ASSET_NOT_FOUND")
    return row


async def _drawn_in_video(session: AsyncSession, plan_id: UUID, user_id: UUID) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(DirectorAsset)
        .where(
            DirectorAsset.plan_id == plan_id,
            DirectorAsset.user_id == user_id,
            DirectorAsset.origin.in_(_DRAWN),
        )
    )
    return count or 0


async def _clips_in_video(
    session: AsyncSession, plan_id: UUID, user_id: UUID, clip_model: str | None
) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(DirectorAsset)
        .where(
            DirectorAsset.plan_id == plan_id,
            DirectorAsset.user_id == user_id,
            DirectorAsset.origin == "created",
            DirectorAsset.model == clip_model,
        )
    )
    return count or 0


async def _drawn_today(session: AsyncSession, user_id: UUID) -> int:
    made = await session.scalar(select(type_coerce(func.ai.images_today(user_id), Integer)))
    return made or 0
