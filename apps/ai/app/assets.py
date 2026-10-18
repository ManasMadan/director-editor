"""Default images for a plan's assets: right after a plan is indexed, Nano Banana draws a
fresh image for each still the Short shows (a chart, a headline card, an end card) from
the asset's prompt and reference, so one is there by the time anyone shoots. Director
never takes the original's picture (docs/director.md): the reference describes it, and
this makes a new one in its style.

The plan job claims the images in the transaction that saves the plan (`claim`, one row
of ai.director_asset each, within the limits below), and queues the `assets` job, which
draws them one at a time (`make`) in the worker: each a model call reserved and settled
in the usage ledger like every other (app/usage.py), stored in MEDIA_BUCKET under the
plan, `director-assets/<planId>/<assetId>.<ext>`, which apps/api turns into a short-lived
link when the template's page asks for its plan. Pydantic AI has no image output for
this model, so the drawing goes through the Gemini client underneath the model Director
builds everything else with (`create_google_model`), as Director's voice does
(app/speech.py).

Off without MEDIA_BUCKET: there would be nowhere to keep them.
"""

import asyncio
from dataclasses import dataclass
from uuid import UUID

from google.cloud import storage  # pyright: ignore[reportMissingTypeStubs]  # no stubs shipped
from google.genai import errors as genai_errors
from google.genai.types import (
    GenerateContentConfig,
    GenerateContentResponse,
    HttpOptions,
    ImageConfig,
)
from pydantic_ai.models.google import GoogleModel
from redis.asyncio import Redis
from sqlalchemy import Integer, func, select, type_coerce, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.activity import Target, log_activity, outcome_of
from app.branding import unbranding
from app.contracts.error_response import ErrorCode
from app.contracts.realtime_message import DirectorChanged
from app.db.models import DirectorAsset, DirectorPlan
from app.db.session import tenant
from app.log import log
from app.realtime import publish_to_org
from app.schemas import AspectRatio, Asset, AssetKind, ShotPlan
from app.usage import Allowance, reserve, settle

# Spec'd limits on generated images (Vertex AI prices to be checked before they're
# final): 12 a video, 30 a day per member, 5 per demo guest. A plan's defaults stop at 5,
# which keeps a guest's one Short inside their own limit and leaves the rest of a
# video's 12 for the member's own versions (the asset picker).
MAX_DEFAULT_ASSETS = 5
IMAGES_PER_MEMBER_PER_DAY = 30
# What Nano Banana can draw as a still; the rest is footage or sound (stock, Veo, Lyria).
STILL_KINDS: frozenset[AssetKind] = frozenset(
    {"image", "cutout", "text-card", "background", "end-card"}
)
# Nano Banana's own shapes for the reference's: half of a vertical split screen (9:8) is
# drawn at the nearest it has and cropped to fit by the editor.
_DRAWN_AS: dict[AspectRatio, str] = {"9:8": "5:4"}
# One image takes a few seconds; past this the call has failed.
DRAW_TIMEOUT_MS = 60_000
KEY_PREFIX = "director-assets"
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg"}
_GENERIC_PERSON = (
    "Anyone in it is a generic, anonymous adult, not a likeness of any real or recognisable person."
)
_NO_MARKS = "No logos, watermarks or brand names anywhere."
# What screens showing a plan, its takes or its images are told when one changes.
CHANGED = DirectorChanged(type="director.changed")


def default_assets(plan: ShotPlan) -> list[Asset]:
    """The assets of `plan` that get a default image: its stills, in the plan's order,
    at most `MAX_DEFAULT_ASSETS`."""
    return [asset for asset in plan.assets if asset.kind in STILL_KINDS][:MAX_DEFAULT_ASSETS]


def image_prompt(asset: Asset) -> str:
    """What Nano Banana is asked for: the asset's own prompt, held to its reference's look
    and its text, and never anyone's likeness or the original's branding (app/branding.py:
    a placeholder stands there instead)."""
    reference = asset.reference
    unbranded = unbranding(reference.brands)
    lines = [
        unbranded(asset.prompt),
        f"Style: {reference.style}. Palette: {reference.palette}.",
        f"Composition: {unbranded(reference.composition)}",
    ]
    if reference.blackAndWhite:
        lines.append("Black and white only, no colour.")
    lines += [f'The text "{unbranded(text)}", spelt exactly like that.' for text in reference.text]
    return "\n".join([*lines, _GENERIC_PERSON, _NO_MARKS])


def images_lock_key(user_id: UUID) -> str:
    """The advisory lock a member's image claims take turns on."""
    return f"ai.director-images:{user_id}"


def drawn_aspect_ratio(asset: Asset) -> str:
    """The shape Nano Banana draws the asset in: its reference's, or the nearest it has."""
    ratio = asset.reference.aspectRatio
    return _DRAWN_AS.get(ratio, ratio)


def asset_key(plan_id: UUID, asset_id: str, media_type: str) -> str:
    """Where an asset's default image is kept (an id the plan's pattern allows, so the
    key stays inside the plan's folder)."""
    return f"{KEY_PREFIX}/{plan_id}/{asset_id}.{_EXTENSIONS[media_type]}"


class NoImage(ValueError):
    """An answer with no image in it (held back by a safety filter, or words instead)."""


@dataclass(frozen=True)
class Drawing:
    data: bytes
    media_type: str
    input_tokens: int
    output_tokens: int


def _drawing(response: GenerateContentResponse) -> Drawing:
    usage = response.usage_metadata
    used = (usage.prompt_token_count or 0, usage.candidates_token_count or 0) if usage else (0, 0)
    parts = [
        part
        for candidate in response.candidates or []
        if candidate.content
        for part in candidate.content.parts or []
    ]
    for part in parts:
        inline = part.inline_data
        if inline and inline.data and inline.mime_type in _EXTENSIONS:
            return Drawing(inline.data, inline.mime_type, *used)
    raise NoImage("no image in the answer")


class Artist:
    """Nano Banana (ASSET_MODEL), drawing one asset at a time."""

    def __init__(self, model: GoogleModel, model_name: str) -> None:
        # The short name for the usage ledger; `model.model_name` is the address sent to
        # Gemini, which on Vertex is the full resource name.
        self._model = model
        self.model_name = model_name

    async def draw(self, asset: Asset) -> Drawing:
        config = GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=ImageConfig(aspect_ratio=drawn_aspect_ratio(asset), image_size="1K"),
            http_options=HttpOptions(timeout=DRAW_TIMEOUT_MS),
        )
        response = await self._model.client.aio.models.generate_content(  # pyright: ignore[reportUnknownMemberType]  # its contents type names Pillow's Image, not installed
            model=self._model.model_name, contents=image_prompt(asset), config=config
        )
        return _drawing(response)


async def upload_bytes(bucket: str, key: str, data: bytes, content_type: str) -> None:
    """Stores `data` at `gs://{bucket}/{key}`, with Application Default Credentials (the
    VM's service account through the metadata server; never a key file)."""
    await asyncio.to_thread(_put, bucket, key, data, content_type)


def _put(bucket: str, key: str, data: bytes, content_type: str) -> None:
    client = storage.Client()
    client.bucket(bucket).blob(key).upload_from_string(  # pyright: ignore[reportUnknownMemberType]  # untyped client
        data, content_type=content_type
    )


def worth_retrying(error: Exception) -> bool:
    """Whether drawing or storing an image again may work: anything but a refusal (a 4xx
    other than being told to slow down) or an answer without an image. Storage's own
    failures are outages here: a bucket this service can't write is its configuration,
    which three tries a few seconds apart don't hide."""
    if isinstance(error, genai_errors.APIError):
        return error.code == 429 or error.code >= 500
    return not isinstance(error, NoImage)


class AssetsInterrupted(Exception):
    """A plan's images to try again (the `assets` job's retry)."""

    def __init__(self, plan_id: UUID) -> None:
        super().__init__(f"images of plan {plan_id} interrupted; retrying")


@dataclass(frozen=True)
class _Job:
    row_id: UUID
    user_id: UUID | None
    asset: Asset


class AssetMaker:
    def __init__(
        self,
        artist: Artist,
        bucket: str,
        redis: Redis,
        *,
        monthly: Allowance,
        per_image: int,
    ) -> None:
        self._artist = artist
        self._bucket = bucket
        self._redis = redis
        self._monthly = monthly
        self._per_image = per_image

    async def claim(
        self,
        session: AsyncSession,
        org_id: UUID,
        plan_id: UUID,
        user_id: UUID | None,
        plan: ShotPlan,
    ) -> int:
        """Queues a default image for each of the plan's stills that the member who
        indexed it still has room for today, inside the caller's transaction (the one
        that saves the plan); how many it queued. A plan nobody indexed (none of this
        service's) counts against nobody's day."""
        assets = default_assets(plan)
        if user_id is not None:
            # The member's claims take turns, so two at once can't both read the same
            # count and pass the day's limit together; the lock is the transaction's.
            await session.execute(
                select(
                    func.pg_advisory_xact_lock(func.hashtextextended(images_lock_key(user_id), 0))
                )
            )
            made = await session.scalar(select(type_coerce(func.ai.images_today(user_id), Integer)))
            assets = assets[: max(IMAGES_PER_MEMBER_PER_DAY - (made or 0), 0)]
        if not assets:
            return 0
        rows = [
            {
                "org_id": org_id,
                "plan_id": plan_id,
                "user_id": user_id,
                "asset_id": asset.id,
                "updated_at": func.now(),
            }
            for asset in assets
        ]
        claimed = await session.scalars(
            insert(DirectorAsset)
            .values(rows)
            .on_conflict_do_nothing(
                index_elements=["plan_id", "asset_id"],
                index_where=DirectorAsset.origin == "default",
            )
            .returning(DirectorAsset.id)
        )
        return len(claimed.all())

    async def make(self, org_id: UUID, plan_id: UUID, *, final: bool) -> None:
        """Draws every image of the plan still to draw (the `assets` job), one at a time,
        announcing each as it lands. Safe to run again: a drawn image is left as it is."""
        for job in await self._jobs(org_id, plan_id):
            await self._draw(org_id, plan_id, job, final=final)
            await publish_to_org(self._redis, org_id, CHANGED)

    async def _jobs(self, org_id: UUID, plan_id: UUID) -> list[_Job]:
        """The plan's images still to draw. One whose asset the saved plan no longer has
        (claimed for a plan that was then indexed again) is failed, never drawn."""
        async with tenant(org_id) as session:
            plan = await session.get(DirectorPlan, plan_id)
            rows = await session.scalars(
                select(DirectorAsset)
                .where(
                    DirectorAsset.plan_id == plan_id,
                    DirectorAsset.origin == "default",
                    DirectorAsset.status.in_(("pending", "generating")),
                )
                .order_by(DirectorAsset.id)
            )
            pending = list(rows)
        if plan is None or plan.status != "ready" or plan.plan is None:
            return []
        assets = {asset.id: asset for asset in ShotPlan.model_validate(plan.plan).assets}
        jobs: list[_Job] = []
        for row in pending:
            asset = assets.get(row.asset_id)
            if asset is None:
                await self._fail(
                    org_id, plan_id, row.id, row.asset_id, row.user_id, "VALIDATION_FAILED"
                )
            else:
                jobs.append(_Job(row.id, row.user_id, asset))
        return jobs

    async def _draw(self, org_id: UUID, plan_id: UUID, job: _Job, *, final: bool) -> None:
        await self._set(org_id, job.row_id, status="generating")
        reservation = await reserve(
            org_id,
            job.user_id,
            "director-asset",
            self._artist.model_name,
            most=self._per_image,
            allowance=self._monthly,
        )
        # The output can't be capped at what's left, so an image waits for a budget that
        # holds a whole one; settling gives the reservation back.
        if reservation is None or reservation.tokens < self._per_image:
            if reservation is not None:
                await settle(reservation, 0, 0)
            await self._fail(
                org_id, plan_id, job.row_id, job.asset.id, job.user_id, "AI_BUDGET_EXCEEDED"
            )
            return
        used = (0, 0)
        try:
            drawing = await self._artist.draw(job.asset)
            used = (drawing.input_tokens, drawing.output_tokens)
            key = asset_key(plan_id, job.asset.id, drawing.media_type)
            await upload_bytes(self._bucket, key, drawing.data, drawing.media_type)
        except Exception as error:
            log.exception("drawing an asset failed", plan_id=str(plan_id), asset=job.asset.id)
            if final or not worth_retrying(error):
                await self._fail(
                    org_id,
                    plan_id,
                    job.row_id,
                    job.asset.id,
                    job.user_id,
                    "UPSTREAM_UNAVAILABLE",
                    used,
                )
                return
            await self._set(org_id, job.row_id, status="pending")
            raise AssetsInterrupted(plan_id) from None
        finally:
            await settle(reservation, *used)
        await self._set(
            org_id, job.row_id, status="ready", object_key=key, model=self._artist.model_name
        )
        log_activity(
            "director.asset_drawn",
            target=self._target(plan_id, job.asset.id, used),
            user_id=job.user_id,
        )

    async def _fail(
        self,
        org_id: UUID,
        plan_id: UUID,
        row_id: UUID,
        asset_id: str,
        user_id: UUID | None,
        code: ErrorCode,
        used: tuple[int, int] = (0, 0),
    ) -> None:
        await self._set(org_id, row_id, status="failed", error=code)
        log_activity(
            "director.asset_drawn",
            outcome=outcome_of(code),
            reason=code,
            target=self._target(plan_id, asset_id, used),
            user_id=user_id,
        )

    def _target(self, plan_id: UUID, asset_id: str, used: tuple[int, int]) -> Target:
        return {
            "planId": str(plan_id),
            "assetId": asset_id,
            "model": self._artist.model_name,
            "inputTokens": used[0],
            "outputTokens": used[1],
        }

    async def _set(self, org_id: UUID, row_id: UUID, **values: str) -> None:
        async with tenant(org_id) as session:
            await session.execute(
                update(DirectorAsset)
                .where(DirectorAsset.id == row_id)
                .values(**values, updated_at=func.now())
            )
