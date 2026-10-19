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
import datetime
import re
from dataclasses import dataclass
from uuid import UUID

from google.cloud import storage  # pyright: ignore[reportMissingTypeStubs]  # no stubs shipped
from google.genai import errors as genai_errors
from google.genai.types import (
    GenerateContentConfig,
    GenerateContentResponse,
    HttpOptions,
    ImageConfig,
    Part,
)
from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.usage import RunUsage, UsageLimits
from redis.asyncio import Redis
from sqlalchemy import Integer, and_, func, or_, select, type_coerce, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.activity import Target, log_activity, outcome_of
from app.branding import unbranding
from app.clips import Filmmaker
from app.contracts.error_response import ErrorCode
from app.contracts.realtime_message import DirectorChanged
from app.db.models import DirectorAsset, DirectorPlan
from app.db.session import tenant
from app.log import log
from app.realtime import publish_to_org
from app.schemas import AspectRatio, Asset, AssetKind, ShotPlan
from app.slots import slot_assets
from app.storyboards import storyboard_asset, storyboard_id, storyboard_prompt
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
# A row "generating" longer than this was left by a job that died: the longest a making
# takes is a Veo clip's (app/clips.py, six minutes of polling), well under it.
CLAIM_STALE_MINUTES = 15
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


def picker_prompt(asset: Asset) -> str:
    """The asset's prompt held to its reference's look and its text, without the
    original's branding (app/branding.py: a placeholder stands there instead): what the
    asset picker's Create tab starts from, for the member to change."""
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
    return "\n".join(lines)


def image_prompt(asset: Asset) -> str:
    """What Nano Banana is asked for a default: the picker's prompt, and never anyone's
    likeness or any branding."""
    return guarded(picker_prompt(asset))


def guarded(prompt: str) -> str:
    """`prompt` with the lines every drawing carries: no likeness, no logos."""
    return "\n".join([prompt, _GENERIC_PERSON, _NO_MARKS])


_CURLY_QUOTES = re.compile("[\u201c\u201d]")


def quoted_text(*prompts: str | None) -> list[str]:
    """The words a prompt puts in quotes: what the image's text must read (text the
    member wants on the image is quoted in the prompt). Every other piece between
    straight or curly double quotes."""
    pieces = [
        piece.strip()
        for prompt in prompts
        if prompt
        for piece in _CURLY_QUOTES.sub('"', prompt).split('"')[1::2]
    ]
    return [piece for piece in pieces if piece]


def expected_text(asset: Asset) -> list[str]:
    """What a default image's text must read: its reference's, without the branding."""
    unbranded = unbranding(asset.reference.brands)
    return [unbranded(text) for text in asset.reference.text]


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


def candidate_key(plan_id: UUID, asset_id: str, row_id: UUID, media_type: str) -> str:
    """Where one of a member's own images for a slot is kept: beside the slot's default,
    in a folder of the slot's own, named by its row."""
    return f"{KEY_PREFIX}/{plan_id}/{asset_id}/{row_id}.{_EXTENSIONS[media_type]}"


class NoImage(ValueError):
    """An answer with no image in it (held back by a safety filter, or words instead)."""


@dataclass(frozen=True)
class Drawing:
    data: bytes
    media_type: str
    input_tokens: int
    output_tokens: int


def drawing_of(response: GenerateContentResponse) -> Drawing:
    """The image in Nano Banana's answer, and the tokens it used: Gemini bills the
    model's thinking as output, and Nano Banana thinks before it draws."""
    usage = response.usage_metadata
    used = (
        (
            usage.prompt_token_count or 0,
            (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
        )
        if usage
        else (0, 0)
    )
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


def _count(usage: RunUsage, drawing: Drawing) -> None:
    usage.input_tokens += drawing.input_tokens
    usage.output_tokens += drawing.output_tokens


class SpellCheck(BaseModel):
    """Gemini's reading of the text in a drawn image: the model's output type."""

    readsRight: bool = Field(
        description="Every line of the expected text is in the image, spelt exactly."
    )
    misspelt: list[str] = Field(description="Words in the image that are spelt wrong.")


SPELLING_INSTRUCTIONS = """\
You proofread the text in an image. You get the image and the text it should show. \
readsRight is true only when every expected line is there, spelt exactly (case and \
punctuation may differ). List any misspelt or garbled words you see in misspelt."""
# A proofreading answer comes in seconds; past this the image is shown unchecked.
SPELLING_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class Picture:
    """An image sent with a prompt: the member's reference photo, or the one to edit."""

    data: bytes
    media_type: str


class Artist:
    """Nano Banana (ASSET_MODEL), drawing one asset at a time; and, given a checker,
    Gemini proofreading the text it drew."""

    def __init__(
        self,
        model: GoogleModel,
        model_name: str,
        checker: Agent[None, SpellCheck] | None = None,
    ) -> None:
        # The short name for the usage ledger; `model.model_name` is the address sent to
        # Gemini, which on Vertex is the full resource name.
        self._model = model
        self.model_name = model_name
        self._checker = checker

    async def draw_prompt(
        self, prompt: str, aspect_ratio: str, pictures: tuple[Picture, ...] = ()
    ) -> Drawing:
        """An image of `prompt` in `aspect_ratio`, drawn from `pictures` when given."""
        config = GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=ImageConfig(aspect_ratio=aspect_ratio, image_size="1K"),
            http_options=HttpOptions(timeout=DRAW_TIMEOUT_MS),
        )
        contents: list[Part] = [
            Part.from_bytes(data=picture.data, mime_type=picture.media_type) for picture in pictures
        ]
        contents.append(Part.from_text(text=prompt))
        response = await self._model.client.aio.models.generate_content(  # pyright: ignore[reportUnknownMemberType]  # its contents type names Pillow's Image, not installed
            model=self._model.model_name, contents=contents, config=config
        )
        return drawing_of(response)

    async def reads_right(
        self, drawing: Drawing, expected: list[str], usage: RunUsage, *, most: int
    ) -> bool:
        """Whether the drawing's text reads `expected`, spelt right, spending at most
        `most` tokens (what's left of the image's reservation), counted in `usage` with
        the drawings. True with nothing to check, no checker, nothing left to spend, or
        a checker that fails: proofreading improves an image, it never stops one being
        shown."""
        if not expected or self._checker is None or most <= 0:
            return True
        try:
            result = await self._checker.run(
                [
                    BinaryContent(data=drawing.data, media_type=drawing.media_type),
                    "The text it should show:\n" + "\n".join(expected),
                ],
                usage=usage,
                usage_limits=UsageLimits(total_tokens_limit=most),
            )
        except Exception:
            log.exception("proofreading an image failed")
            return True
        return result.output.readsRight


def create_checker(model: GoogleModel) -> Agent[None, SpellCheck]:
    """Gemini (DIRECTOR_MODEL), proofreading a drawn image's text."""
    return Agent(
        model,
        output_type=SpellCheck,
        instructions=SPELLING_INSTRUCTIONS,
        model_settings={"timeout": SPELLING_TIMEOUT_SECONDS},
        defer_model_check=True,
    )


async def upload_bytes(bucket: str, key: str, data: bytes, content_type: str) -> None:
    """Stores `data` at `gs://{bucket}/{key}`, with Application Default Credentials (the
    VM's service account through the metadata server; never a key file)."""
    await asyncio.to_thread(_put, bucket, key, data, content_type)


def _put(bucket: str, key: str, data: bytes, content_type: str) -> None:
    client = storage.Client()
    client.bucket(bucket).blob(key).upload_from_string(  # pyright: ignore[reportUnknownMemberType]  # untyped client
        data, content_type=content_type
    )


# The largest picture read back to draw from: an upload's limit (packages/contracts
# files.ts, director-asset-image).
MAX_PICTURE_BYTES = 15_000_000
_PICTURE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})


class _PictureFacts(BaseModel):
    """What Cloud Storage says of a stored object (its client is untyped)."""

    size: int | None
    contentType: str | None


async def download_picture(bucket: str, key: str) -> Picture:
    """The image at `gs://{bucket}/{key}` (an upload, or another of a slot's images), to
    draw from. NoImage when it isn't there, isn't an image or is larger than an upload."""
    return await asyncio.to_thread(_get, bucket, key)


def _get(bucket: str, key: str) -> Picture:
    blob = storage.Client().bucket(bucket).get_blob(key)  # pyright: ignore[reportUnknownMemberType]  # untyped client
    if blob is None:
        raise NoImage(f"no picture at {key}")
    size = _PictureFacts.model_validate(
        {"size": blob.size, "contentType": blob.content_type},  # pyright: ignore[reportAny]  # untyped client
    )
    media_type = size.contentType or ""
    if (size.size or 0) > MAX_PICTURE_BYTES or media_type not in _PICTURE_TYPES:
        raise NoImage(f"not a picture to draw from: {key}")
    data: bytes = blob.download_as_bytes()  # pyright: ignore[reportUnknownMemberType]  # untyped client
    return Picture(data, media_type)


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
    # A member's own drawing (origin created): its prompt, the photo it's drawn from, and
    # the image it edits (the prompt then says what to change). None for a default.
    prompt: str | None = None
    reference_key: str | None = None
    base_key: str | None = None
    base_prompt: str | None = None
    # A Veo clip for a gap (app/clips.py) rather than a drawn still.
    clip: bool = False
    # A created plan's storyboard card (origin storyboard): the prompt it's drawn from. Its
    # asset stands in for the card, so it's stored and logged like a default.
    storyboard: str | None = None


async def _room_today(session: AsyncSession, user_id: UUID | None, wanted: int) -> int:
    """How many of `wanted` images the member still has room for today. Their claims
    take turns, so two at once can't both read the same count and pass the day's limit
    together; the lock is the caller's transaction's. An image nobody asked for (a seed's,
    none of this service's) counts against nobody's day."""
    if user_id is None:
        return wanted
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(images_lock_key(user_id), 0)))
    )
    made = await session.scalar(select(type_coerce(func.ai.images_today(user_id), Integer)))
    return min(wanted, max(IMAGES_PER_MEMBER_PER_DAY - (made or 0), 0))


class AssetMaker:
    def __init__(
        self,
        artist: Artist,
        bucket: str,
        redis: Redis,
        *,
        monthly: Allowance,
        per_image: int,
        filmmaker: Filmmaker | None = None,
        per_clip: int = 0,
    ) -> None:
        self._artist = artist
        self._bucket = bucket
        self._redis = redis
        self._monthly = monthly
        self._per_image = per_image
        self._filmmaker = filmmaker
        self._per_clip = per_clip

    @property
    def clip_model(self) -> str | None:
        """The Veo model that makes gaps' clips; None when clips are off."""
        return self._filmmaker.model_name if self._filmmaker else None

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
        assets = assets[: await _room_today(session, user_id, len(assets))]
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

    async def claim_storyboards(
        self,
        session: AsyncSession,
        org_id: UUID,
        plan_id: UUID,
        user_id: UUID | None,
        plan: ShotPlan,
    ) -> int:
        """Queues a storyboard card for each shot of a created plan that has none yet (a
        new shot, or one whose directions changed), inside the caller's transaction and
        the member's day's limit; how many it queued. Only the transaction that saves the
        plan writes its cards, so the ones already there are read rather than held off by
        a unique index."""
        existing = set(
            await session.scalars(
                select(DirectorAsset.asset_id).where(
                    DirectorAsset.plan_id == plan_id, DirectorAsset.origin == "storyboard"
                )
            )
        )
        wanted = [
            card
            for card in dict.fromkeys(storyboard_id(shot) for shot in plan.shots)
            if card not in existing
        ]
        wanted = wanted[: await _room_today(session, user_id, len(wanted))]
        if not wanted:
            return 0
        await session.execute(
            insert(DirectorAsset).values(
                [
                    {
                        "org_id": org_id,
                        "plan_id": plan_id,
                        "user_id": user_id,
                        "asset_id": card,
                        "origin": "storyboard",
                        "updated_at": func.now(),
                    }
                    for card in wanted
                ]
            )
        )
        return len(wanted)

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
                    DirectorAsset.origin.in_(("default", "created", "storyboard")),
                    DirectorAsset.status.in_(("pending", "generating")),
                )
                .order_by(DirectorAsset.id)
            )
            pending = list(rows)
            wanted = [row.base_id for row in pending if row.base_id is not None]
            bases = {
                base.id: base
                for base in await session.scalars(
                    select(DirectorAsset).where(DirectorAsset.id.in_(wanted))
                )
            }
        if plan is None or plan.status != "ready" or plan.plan is None:
            return []
        shot_plan = ShotPlan.model_validate(plan.plan)
        assets = {asset.id: asset for asset in slot_assets(shot_plan)}
        cards = {storyboard_id(shot): shot for shot in shot_plan.shots}
        jobs: list[_Job] = []
        for row in pending:
            card = cards.get(row.asset_id) if row.origin == "storyboard" else None
            if card is not None:
                jobs.append(
                    _Job(
                        row.id,
                        row.user_id,
                        storyboard_asset(card),
                        storyboard=storyboard_prompt(card),
                    )
                )
                continue
            asset = assets.get(row.asset_id) if row.origin != "storyboard" else None
            base = bases.get(row.base_id) if row.base_id is not None else None
            lost_base = row.base_id is not None and (base is None or base.object_key is None)
            if asset is None or lost_base:
                await self._fail(
                    org_id, plan_id, row.id, row.asset_id, row.user_id, "VALIDATION_FAILED"
                )
            elif row.origin == "default":
                jobs.append(_Job(row.id, row.user_id, asset))
            else:
                jobs.append(
                    _Job(
                        row.id,
                        row.user_id,
                        asset,
                        prompt=row.prompt or picker_prompt(asset),
                        reference_key=row.reference_key,
                        base_key=base.object_key if base else None,
                        base_prompt=base.prompt if base else None,
                        clip=row.model is not None and row.model == self.clip_model,
                    )
                )
        return jobs

    async def _drawing(
        self, plan_id: UUID, job: _Job, usage: RunUsage, reserved: int
    ) -> tuple[Drawing, str]:
        """Draws the job's image, proofreads its text and draws it once more when it's
        misspelt (a misspelt result is regenerated once before it's shown); the drawing
        kept and where it's stored. Every call's tokens go into `usage` as it's answered,
        so a failure part way still counts what was spent; the proofreading runs on the
        image's reservation (`reserved`), capped at what the first drawing left of it."""
        if job.storyboard is not None:
            prompt, expected, pictures = job.storyboard, [], ()
        elif job.prompt is None:
            prompt, expected, pictures = image_prompt(job.asset), expected_text(job.asset), ()
        else:
            prompt, expected, pictures = await self._own_drawing(job)
        aspect = drawn_aspect_ratio(job.asset)
        drawing = await self._artist.draw_prompt(prompt, aspect, pictures)
        _count(usage, drawing)
        left = reserved - usage.total_tokens
        if not await self._artist.reads_right(drawing, expected, usage, most=left):
            quoted = "; ".join(f'"{text}"' for text in expected)
            respelt = f"{prompt}\nSpell every word of the text exactly as quoted: {quoted}"
            drawing = await self._artist.draw_prompt(respelt, aspect, pictures)
            _count(usage, drawing)
        key = (
            asset_key(plan_id, job.asset.id, drawing.media_type)
            if job.prompt is None
            else candidate_key(plan_id, job.asset.id, job.row_id, drawing.media_type)
        )
        return drawing, key

    async def _own_drawing(self, job: _Job) -> tuple[str, list[str], tuple[Picture, ...]]:
        """A member's drawing: the prompt sent, the text it must read, and the pictures
        it's drawn from."""
        prompt = job.prompt or ""
        if job.base_key is not None:
            base = await download_picture(self._bucket, job.base_key)
            expected = quoted_text(prompt) or quoted_text(job.base_prompt)
            sent = guarded(f"Edit this image: {prompt}\nKeep everything else as it is.")
            return sent, expected, (base,)
        pictures: tuple[Picture, ...] = ()
        lines = [prompt]
        if job.reference_key is not None:
            pictures = (await download_picture(self._bucket, job.reference_key),)
            lines.append(
                "Draw it from the attached photo: keep what the photo shows, and give it "
                "the look described above."
            )
        return guarded("\n".join(lines)), quoted_text(prompt), pictures

    async def _film(self, org_id: UUID, plan_id: UUID, job: _Job, filmmaker: Filmmaker) -> None:
        """Makes a gap's Veo clip, counted against the workspace's allowance as a fixed
        `per_clip` (Veo is priced by the second, not by tokens)."""
        if not await self._claim(org_id, job.row_id):
            return
        reservation = await reserve(
            org_id,
            job.user_id,
            "director-asset",
            filmmaker.model_name,
            most=self._per_clip,
            allowance=self._monthly,
            # A clip costs what it costs: it waits for a budget that holds a whole one.
            least=self._per_clip,
        )
        if reservation is None:
            await self._fail(
                org_id, plan_id, job.row_id, job.asset.id, job.user_id, "AI_BUDGET_EXCEEDED"
            )
            return
        key = f"{KEY_PREFIX}/{plan_id}/{job.asset.id}/{job.row_id}.mp4"
        used = (0, 0)
        try:
            clip = await filmmaker.film(job.prompt or job.asset.prompt)
            used = (0, self._per_clip)
            await upload_bytes(self._bucket, key, clip.data, "video/mp4")
        except Exception:
            # Veo is dear: a failed clip is never tried again by itself; the member can ask again.
            log.exception("making a clip failed", plan_id=str(plan_id), asset=job.asset.id)
            await self._fail(
                org_id, plan_id, job.row_id, job.asset.id, job.user_id, "UPSTREAM_UNAVAILABLE"
            )
            return
        finally:
            await settle(reservation, *used)
        await self._set(org_id, job.row_id, status="ready", object_key=key)
        log_activity(
            "director.asset_drawn",
            target={**self._target(plan_id, job.asset.id, used), "model": filmmaker.model_name},
            user_id=job.user_id,
        )

    async def _draw(self, org_id: UUID, plan_id: UUID, job: _Job, *, final: bool) -> None:
        # A job is a clip only when its row names Veo's model, which needs the filmmaker.
        if job.clip and self._filmmaker is not None:
            await self._film(org_id, plan_id, job, self._filmmaker)
            return
        if not await self._claim(org_id, job.row_id):
            return
        reservation = await reserve(
            org_id,
            job.user_id,
            "director-asset",
            self._artist.model_name,
            most=self._per_image,
            allowance=self._monthly,
            # The output can't be capped at what's left, so an image waits for a budget
            # that holds a whole one.
            least=self._per_image,
        )
        if reservation is None:
            await self._fail(
                org_id, plan_id, job.row_id, job.asset.id, job.user_id, "AI_BUDGET_EXCEEDED"
            )
            return
        usage = RunUsage()
        try:
            drawing, key = await self._drawing(plan_id, job, usage, reservation.tokens)
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
                    (usage.input_tokens, usage.output_tokens),
                )
                return
            await self._set(org_id, job.row_id, status="pending")
            raise AssetsInterrupted(plan_id) from None
        finally:
            await settle(reservation, usage.input_tokens, usage.output_tokens)
        await self._set(
            org_id, job.row_id, status="ready", object_key=key, model=self._artist.model_name
        )
        used = (usage.input_tokens, usage.output_tokens)
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

    async def _claim(self, org_id: UUID, row_id: UUID) -> bool:
        """Takes the row for this job to draw, in one statement: whether it got it. Every
        picker drawing and created plan queues a job for the whole plan, and two jobs can
        list the same rows, so only the one whose update lands draws it (a Veo clip twice
        is billed twice). A row left "generating" past CLAIM_STALE_MINUTES by a job that died is
        taken again."""
        stale = func.now() - datetime.timedelta(minutes=CLAIM_STALE_MINUTES)
        async with tenant(org_id) as session:
            claimed = await session.scalar(
                update(DirectorAsset)
                .where(
                    DirectorAsset.id == row_id,
                    or_(
                        DirectorAsset.status == "pending",
                        and_(
                            DirectorAsset.status == "generating",
                            DirectorAsset.updated_at < stale,
                        ),
                    ),
                )
                .values(status="generating", updated_at=func.now())
                .returning(DirectorAsset.id)
            )
        if claimed is None:
            log.info("an asset another job is making", row_id=str(row_id))
        return claimed is not None

    async def _set(self, org_id: UUID, row_id: UUID, **values: str) -> None:
        async with tenant(org_id) as session:
            await session.execute(
                update(DirectorAsset)
                .where(DirectorAsset.id == row_id)
                .values(**values, updated_at=func.now())
            )
