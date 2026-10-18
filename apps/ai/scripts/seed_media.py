"""Makes the 6 seed templates' media with Google's generative models on Vertex AI, and
records it in packages/contracts/src/director-seeds.json:

- a storyboard card per shot, drawn by Nano Banana (`STORYBOARD_MODEL`):
  seed-media/<videoId>/shot-<n>.png
- a few seconds' preview clip per shot, by Veo (`PREVIEW_MODEL`), silent, 720p, 9:16:
  seed-media/<videoId>/shot-<n>.mp4
- a music track per seed, by Lyria (`MUSIC_MODEL`), matched to its moods and pace:
  seed-media/<videoId>/music.<the format Lyria answers with>
- the default image of each still among its plan's assets (a chart, a headline card, an
  end card), by Nano Banana from the asset's own prompt and reference, as the plan job
  makes a member's (app/assets.py): seed-media/<videoId>/asset-<assetId>.png

<n> is the shot's index in the plan (from 0, the API's `shotIndex`). Each prompt is made
only from the shot's own directions (where, the framing, who or what is in it, the
feeling it's going for, how the camera moves), never from titles, steps or script lines,
which can name a brand; anyone in a picture is a generic person, never a likeness of the
Short's creator. Run from the repo root, after `seeds:build` (which keeps the media of
any seed whose plan came out unchanged, and drops it otherwise):

    bun run --filter @repo/ai seeds:media -- --bucket <bucket> [--concurrency 1-8]
    bun run --filter @repo/ai seeds:media -- --dry-run

with <bucket> the Cloud Storage bucket the API serves files from: production's,
director-media-1053522546520, where the seeds' audio already is. The keys are the same
everywhere, so an API reading another bucket (RustFS locally) finds nothing at them and
its links 404. It says how many of each it will make and what that should cost before
making any; `--dry-run` (no bucket needed) stops there and lists every prompt. It only
makes what has no key yet, writing each key into the seed entry's `media` as soon as its
object is uploaded, so a run that stops halfway (or a medium that fails) is finished by
running it again; commit the seed file and the ledger afterwards. Veo clips are capped
at `MAX_PREVIEWS` across every run, counted on the ledger (`Ledger`,
scripts/seed-media-ledger.json): every clip Veo answered with, kept or not.

Runs on a developer's machine, never in a service, as the gcloud account signed in on
it (`gcloud auth print-access-token`), with no key file: the project's express-mode API
key is for the Gemini calls the services make, not for this. It needs
GOOGLE_CLOUD_PROJECT (the project billed, whose Vertex AI and bucket it uses) and reads
VERTEX_LOCATION for Nano Banana and Lyria; Veo is served from `PREVIEW_LOCATION`.
"""

import argparse
import asyncio
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from functools import partial
from http import HTTPStatus
from pathlib import Path
from typing import Literal, Protocol

from google import genai
from google.cloud import storage  # pyright: ignore[reportMissingTypeStubs]  # no stubs shipped
from google.genai import errors as genai_errors
from google.genai.types import (
    GenerateContentConfig,
    GenerateContentResponse,
    GenerateVideosConfig,
    HttpOptions,
    ImageConfig,
)
from google.oauth2.credentials import Credentials as UserCredentials
from pydantic import BaseModel, TypeAdapter

from app.assets import default_assets, drawn_aspect_ratio, image_prompt
from app.log import configure_logging, log
from app.schemas import Shot, ShotPlan
from app.settings import Settings, get_settings
from app.storyboards import GENERIC_PERSON, shot_directions, storyboard_prompt
from scripts.build_seeds import (
    APP_ROOT,
    TEMPLATES_PATH,
    SeedMedia,
    SeedShotMedia,
    SeedTemplate,
    load_templates,
    write_templates,
)

# The models, each checked to answer on Vertex AI on 2026-10-18: Nano Banana 2.1, Veo 3.1
# Lite and Lyria 3 Clip (about 30 seconds of music).
STORYBOARD_MODEL = "gemini-nano-banana-2.1"
PREVIEW_MODEL = "veo-3.1-lite-generate-001"
MUSIC_MODEL = "lyria-3-clip-preview"
# Veo isn't served from the "global" location the Gemini models are.
PREVIEW_LOCATION = "us-central1"
MAX_PREVIEWS = 40
LEDGER_PATH = APP_ROOT / "scripts" / "seed-media-ledger.json"
# Vertex AI's list prices on 2026-10-18, for the estimate printed before a run: a 1K
# image (1,120 output tokens, plus the model's thinking), a second of 720p video without
# sound, one Lyria 3 Clip track.
STORYBOARD_USD = 0.04
PREVIEW_USD_PER_SECOND = 0.03
MUSIC_USD = 0.04
# Veo takes about 40 seconds a clip; how often to ask whether it's done.
POLL_SECONDS = 10.0
# A spent quota (429) is per minute: wait 20 s, then 40, 80 and 160 before giving up.
QUOTA_ATTEMPTS = 5
QUOTA_RETRY_SECONDS = 20.0
GCLOUD_TOKEN = ("gcloud", "auth", "print-access-token")
PREVIEW_NEGATIVE_PROMPT = "text, captions, subtitles, logos, watermarks, brand names"

_MOVES = {
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "forward": "forward",
    "back": "back",
    "orbit": "around the subject",
    "tilt-up": "by tilting up",
    "tilt-down": "by tilting down",
}
# What each answer's type is stored as; anything else fails that medium.
_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}

type MediaKind = Literal["storyboard", "preview", "music", "asset"]
# A model's answer: the file's bytes and its media type.
type Media = tuple[bytes, str]
# Uploads bytes to a key in the bucket, with their media type.
type Upload = Callable[[str, bytes, str], Awaitable[None]]


class MediaModels(Protocol):
    async def storyboard(self, prompt: str) -> Media: ...
    async def preview(self, prompt: str, seconds: int) -> Media: ...
    async def music(self, prompt: str) -> Media: ...
    async def asset(self, prompt: str, aspect_ratio: str) -> Media: ...


type Connect = Callable[[Settings, str], Awaitable[tuple[MediaModels, Upload]]]


@dataclass(frozen=True)
class Job:
    """One medium to make: for the `seed`-th template, its `shot`-th shot (None: the
    seed's music, or an asset's image), from `prompt`; a preview `seconds` long; an
    asset's image of `asset_id`, drawn `aspect_ratio`."""

    kind: MediaKind
    seed: int
    shot: int | None
    prompt: str
    seconds: int = 0
    asset_id: str | None = None
    aspect_ratio: str = "9:16"


# --------------------------------------------------------------------------------- prompts


def _camera(shot: Shot) -> str:
    moves = list(
        dict.fromkeys(_MOVES[s.cameraMove] for s in shot.steps if s.cameraMove != "static")
    )
    return f"The camera moves {', then '.join(moves)}." if moves else "The camera holds still."


def preview_seconds(shot: Shot) -> Literal[4, 6]:
    """Veo makes 4, 6 or 8 seconds: the shortest that shows a short shot, and at most 6
    (a preview, not the shot itself)."""
    return 4 if shot.durationSeconds <= 5 else 6


def preview_prompt(shot: Shot, seconds: int) -> str:
    return "\n".join(
        [
            f"A {seconds}-second vertical 9:16 phone video, handheld, in natural light.",
            *shot_directions(shot),
            _camera(shot),
            GENERIC_PERSON,
            "No on-screen text, captions, logos or watermarks.",
        ]
    )


def _pace(seconds_per_shot: float) -> tuple[str, str]:
    if seconds_per_shot <= 3:
        return "fast", "around 120 to 130 BPM"
    if seconds_per_shot <= 8:
        return "steady", "around 100 to 115 BPM"
    return "slow", "around 70 to 90 BPM"


def music_prompt(plan: ShotPlan) -> str:
    count = len(plan.shots)
    every = plan.durationSeconds / count
    pace, tempo = _pace(every)
    moods = "; ".join(shot.purpose for shot in plan.shots)
    return (
        "Instrumental only, no vocals or lyrics. Background music for a "
        f"{round(plan.durationSeconds)}-second vertical video in the style of: {plan.format}. "
        f"Its {count} shot{'s' if count != 1 else ''}, in order: {moods}. "
        f"Pace: {pace}, a cut about every {every:.0f} seconds, so {tempo}. "
        "Follow those moods in that order and end cleanly."
    )


# ---------------------------------------------------------------------------- what to make


def _media_of(template: SeedTemplate) -> SeedMedia:
    """The seed's media so far: an empty entry per shot until it has any."""
    return template.media or SeedMedia(shots=[SeedShotMedia() for _ in template.plan.shots])


def media_jobs(
    templates: list[SeedTemplate], billed: int = 0, max_previews: int = MAX_PREVIEWS
) -> list[Job]:
    """Every medium the seeds have no key for yet, in the seed file's order; previews only
    up to `max_previews` across every run, counting the `billed` clips Veo has already
    answered with (the ledger: a clip is paid for whether or not its key was kept)."""
    previews_left = max_previews - billed
    held_back = 0
    jobs: list[Job] = []
    for seed, template in enumerate(templates):
        media = _media_of(template)
        for index, (shot, made) in enumerate(zip(template.plan.shots, media.shots, strict=True)):
            if made.storyboard is None:
                jobs.append(Job("storyboard", seed, index, storyboard_prompt(shot)))
            if made.preview is None and previews_left <= 0:
                held_back += 1
            elif made.preview is None:
                seconds = preview_seconds(shot)
                jobs.append(Job("preview", seed, index, preview_prompt(shot, seconds), seconds))
                previews_left -= 1
        if media.music is None:
            jobs.append(Job("music", seed, None, music_prompt(template.plan)))
        jobs += [
            Job(
                "asset",
                seed,
                None,
                image_prompt(asset),
                asset_id=asset.id,
                aspect_ratio=drawn_aspect_ratio(asset),
            )
            for asset in default_assets(template.plan)
            if asset.id not in media.assets
        ]
    if held_back:
        log.warning("previews held back at the cap", held_back=held_back, cap=max_previews)
    return jobs


def _price(job: Job) -> float:
    if job.kind == "preview":
        return job.seconds * PREVIEW_USD_PER_SECOND
    # An asset's image is a 1K Nano Banana image, like a storyboard card.
    return MUSIC_USD if job.kind == "music" else STORYBOARD_USD


def estimated_usd(jobs: list[Job]) -> float:
    return sum(_price(job) for job in jobs)


# -------------------------------------------------------------------------------- the run


async def _make(
    template: SeedTemplate,
    job: Job,
    models: MediaModels,
    upload: Upload,
    billed: Callable[[Job], None],
) -> None:
    if job.kind == "storyboard":
        data, media_type = await models.storyboard(job.prompt)
    elif job.kind == "preview":
        data, media_type = await models.preview(job.prompt, job.seconds)
        # Paid for from here on, whatever becomes of it.
        billed(job)
    elif job.kind == "asset":
        data, media_type = await models.asset(job.prompt, job.aspect_ratio)
    else:
        data, media_type = await models.music(job.prompt)
    extension = _EXTENSIONS.get(media_type)
    if extension is None:
        raise ValueError(f"no file extension for a {job.kind} of type {media_type}")
    key = f"seed-media/{template.videoId}/{_name(job)}.{extension}"
    await upload(key, data, media_type)
    media = _media_of(template)
    template.media = media
    if job.asset_id is not None:
        media.assets[job.asset_id] = key
    elif job.shot is None:
        media.music = key
    elif job.kind == "storyboard":
        media.shots[job.shot].storyboard = key
    else:
        media.shots[job.shot].preview = key


def _name(job: Job) -> str:
    """The medium's file name in the seed's folder, without its extension."""
    if job.asset_id is not None:
        return f"asset-{job.asset_id}"
    return "music" if job.shot is None else f"shot-{job.shot}"


async def generate(
    templates: list[SeedTemplate],
    jobs: list[Job],
    models: MediaModels,
    upload: Upload,
    save: Callable[[list[SeedTemplate]], None],
    billed: Callable[[Job], None],
    concurrency: int = 3,
) -> int:
    """Makes every job, `concurrency` at a time, saving the templates after each one
    lands and telling `billed` of each clip Veo answers with; returns how many failed
    (logged, their keys left unset for the next run)."""
    slots = asyncio.Semaphore(concurrency)

    async def run(job: Job) -> bool:
        template = templates[job.seed]
        async with slots:
            try:
                await _make(template, job, models, upload, billed)
            except Exception:
                log.exception(
                    "seed media failed", kind=job.kind, video_id=template.videoId, shot=job.shot
                )
                return False
        save(templates)
        log.info("made seed media", kind=job.kind, video_id=template.videoId, shot=job.shot)
        return True

    made = await asyncio.gather(*(run(job) for job in jobs))
    return made.count(False)


# ---------------------------------------------------------------- Vertex AI and the bucket


def _inline(response: GenerateContentResponse, kind: str) -> Media:
    """The first file of `kind` ("image", "audio") in a generateContent answer."""
    content = response.candidates[0].content if response.candidates else None
    for part in (content.parts if content else None) or []:
        blob = part.inline_data
        if blob and blob.data and blob.mime_type and blob.mime_type.startswith(f"{kind}/"):
            return blob.data, blob.mime_type
    raise RuntimeError(f"the model answered with no {kind}")


class _ContentModels(Protocol):
    """What this uses of google-genai's generateContent: its own signature also takes
    PIL images, which aren't installed, so its type is partly unknown."""

    async def generate_content(
        self, *, model: str, contents: str, config: GenerateContentConfig
    ) -> GenerateContentResponse: ...


class VertexMediaModels:
    """Nano Banana, Veo and Lyria through google-genai's client on Vertex AI: `images`
    (Nano Banana and Lyria) at the configured location, `videos` (Veo) at
    `PREVIEW_LOCATION`."""

    def __init__(
        self,
        images: genai.Client,
        videos: genai.Client,
        refresh: Callable[[], Awaitable[None]],
        poll_seconds: float = POLL_SECONDS,
        retry_seconds: float = QUOTA_RETRY_SECONDS,
    ) -> None:
        self._refresh = refresh
        # Held for the whole run: google-genai closes a client's connections as soon as
        # nothing holds the client, and its `models` alone doesn't.
        self._images = images
        self._content: _ContentModels = images.aio.models
        self._videos = videos
        self._poll_seconds = poll_seconds
        self._retry_seconds = retry_seconds

    async def _retried[T](self, call: Callable[[], Awaitable[T]]) -> T:
        """`call`, with a fresh token, tried again once with another when Vertex answers
        401 (it expired during a long wait), and after a wait while it answers 429 (a
        model's quota per minute is spent; Veo's is a few requests). Any other refusal,
        or a quota still spent after `QUOTA_ATTEMPTS`, fails at once."""
        await self._refresh()
        attempt, wait, renewed = 1, self._retry_seconds, False
        while True:
            try:
                return await call()
            except genai_errors.ClientError as error:
                if error.code == HTTPStatus.UNAUTHORIZED and not renewed:
                    await self._refresh()
                    renewed = True
                    continue
                if error.code != HTTPStatus.TOO_MANY_REQUESTS or attempt == QUOTA_ATTEMPTS:
                    raise
                log.info("quota spent, waiting", attempt=attempt, seconds=wait)
                await asyncio.sleep(wait)
                attempt, wait = attempt + 1, wait * 2

    async def storyboard(self, prompt: str) -> Media:
        return await self.asset(prompt, "9:16")

    async def asset(self, prompt: str, aspect_ratio: str) -> Media:
        config = GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=ImageConfig(aspect_ratio=aspect_ratio, image_size="1K"),
        )
        response = await self._retried(
            lambda: self._content.generate_content(
                model=STORYBOARD_MODEL, contents=prompt, config=config
            )
        )
        return _inline(response, "image")

    async def music(self, prompt: str) -> Media:
        # Lyria 3 answers with its caption of the track as text alongside the audio, and
        # refuses a request that asks for the audio alone.
        config = GenerateContentConfig(response_modalities=["AUDIO", "TEXT"])
        response = await self._retried(
            lambda: self._content.generate_content(
                model=MUSIC_MODEL, contents=prompt, config=config
            )
        )
        return _inline(response, "audio")

    async def preview(self, prompt: str, seconds: int) -> Media:
        config = GenerateVideosConfig(
            aspect_ratio="9:16",
            duration_seconds=seconds,
            resolution="720p",
            number_of_videos=1,
            generate_audio=False,
            person_generation="allow_adult",
            negative_prompt=PREVIEW_NEGATIVE_PROMPT,
        )
        operation = await self._retried(
            lambda: self._videos.aio.models.generate_videos(
                model=PREVIEW_MODEL, prompt=prompt, config=config
            )
        )
        while not operation.done:
            await asyncio.sleep(self._poll_seconds)
            operation = await self._retried(partial(self._videos.aio.operations.get, operation))
        if operation.error:
            raise RuntimeError(f"Veo failed: {operation.error}")
        answer = operation.response
        video = answer.generated_videos[0].video if answer and answer.generated_videos else None
        if video is None or not video.video_bytes:
            # Its safety filters held the clip back; the reasons say which filter.
            reasons = answer.rai_media_filtered_reasons if answer else None
            raise RuntimeError(f"Veo answered with no video: {reasons}")
        return video.video_bytes, video.mime_type or "video/mp4"


async def access_token(command: Sequence[str] = GCLOUD_TOKEN) -> str:
    """The signed-in gcloud account's access token (never printed or logged)."""
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    stdout, _ = await process.communicate()
    if process.returncode != 0:
        raise RuntimeError(
            "gcloud printed no access token: sign in with `gcloud auth login` (or "
            "`gcloud auth application-default login`) and run this again"
        )
    return stdout.decode().strip()


class GcloudToken:
    """The signed-in gcloud account as credentials for Google's clients. Its token is
    asked of gcloud again before each call and upload, and whenever Google answers 401:
    one lasts an hour, and a run with quota waits takes longer. gcloud hands back the
    token it has cached until that one nears its end, so asking is cheap."""

    def __init__(self, command: Sequence[str] = GCLOUD_TOKEN) -> None:
        self._command = command
        self.credentials = UserCredentials(None)

    async def refresh(self) -> None:
        self.credentials.token = await access_token(self._command)


def gcs_upload(bucket: str, token: GcloudToken, project: str) -> Upload:
    client = storage.Client(project=project, credentials=token.credentials)

    def put(key: str, data: bytes, content_type: str) -> None:
        client.bucket(bucket).blob(key).upload_from_string(  # pyright: ignore[reportUnknownMemberType]  # untyped client
            data, content_type=content_type
        )

    async def upload(key: str, data: bytes, content_type: str) -> None:
        await token.refresh()
        await asyncio.to_thread(put, key, data, content_type)

    return upload


async def connect_vertex(
    settings: Settings,
    bucket: str,
    poll_seconds: float = POLL_SECONDS,
    retry_seconds: float = QUOTA_RETRY_SECONDS,
    token_command: Sequence[str] = GCLOUD_TOKEN,
) -> tuple[MediaModels, Upload]:
    project = settings.google_cloud_project
    if not project:
        raise ValueError(
            "GOOGLE_CLOUD_PROJECT must name the project whose Vertex AI and bucket to use"
        )
    # The signed-in gcloud account, which needs no key file and no extra login on a
    # developer's machine. Its first token before the clients are built: an empty one
    # would have them try to renew it themselves, which these credentials can't.
    token = GcloudToken(token_command)
    await token.refresh()
    # GOOGLE_BASE_URL is another endpoint for Google's APIs (a gateway, or a test's
    # stand-in), as for every other Gemini call.
    http_options = (
        HttpOptions(base_url=str(settings.google_base_url)) if settings.google_base_url else None
    )

    def client(location: str) -> genai.Client:
        return genai.Client(
            vertexai=True,
            project=project,
            location=location,
            credentials=token.credentials,
            http_options=http_options,
        )

    models = VertexMediaModels(
        client(settings.vertex_location),
        client(PREVIEW_LOCATION),
        token.refresh,
        poll_seconds,
        retry_seconds,
    )
    return models, gcs_upload(bucket, token, project)


# ---------------------------------------------------------------------------- the command


class _BilledClip(BaseModel):
    videoId: str
    shot: int | None
    seconds: int


_CLIPS = TypeAdapter(list[_BilledClip])


class Ledger:
    """Every clip Veo has answered with, across every run: what `MAX_PREVIEWS` caps, so
    it bounds the bill rather than only the clips whose keys were kept (a clip whose
    upload then failed was still paid for). Committed beside this script, so a run on
    another machine counts the same; a filtered clip isn't billed and isn't on it."""

    def __init__(self, path: Path = LEDGER_PATH) -> None:
        self._path = path
        self._clips = _CLIPS.validate_json(path.read_text()) if path.exists() else []

    def count(self) -> int:
        return len(self._clips)

    def record(self, video_id: str, job: Job) -> None:
        self._clips.append(_BilledClip(videoId=video_id, shot=job.shot, seconds=job.seconds))
        self._path.write_text(_CLIPS.dump_json(self._clips, indent=2).decode() + "\n")


class _Arguments(argparse.Namespace):
    bucket: str | None = None
    dry_run: bool = False
    concurrency: int = 3


MAX_CONCURRENCY = 8


def _concurrency(value: str) -> int:
    # More at once only meets Vertex's per-minute quotas sooner (each call then waits
    # them out), and a slip like 100 would start that many paid generations together.
    if not value.isdigit() or not 1 <= int(value) <= MAX_CONCURRENCY:
        raise argparse.ArgumentTypeError(f"a number from 1 to {MAX_CONCURRENCY}")
    return int(value)


def parse_args(argv: Sequence[str] | None) -> _Arguments:
    parser = argparse.ArgumentParser(description="Make the seed templates' media.")
    parser.add_argument(
        "--bucket", help="the Cloud Storage bucket the API serves files from (not for --dry-run)"
    )
    parser.add_argument("--dry-run", action="store_true", help="say what it would make, and stop")
    parser.add_argument(
        "--concurrency", type=_concurrency, default=3, help="media made at once (1 to 8)"
    )
    arguments = parser.parse_args(argv, namespace=_Arguments())
    if not arguments.dry_run and not arguments.bucket:
        parser.error("--bucket is needed to make media (only --dry-run goes without)")
    return arguments


async def main(
    argv: Sequence[str] | None = None,
    templates_path: Path = TEMPLATES_PATH,
    connect: Connect = connect_vertex,
    ledger_path: Path = LEDGER_PATH,
) -> int:
    arguments = parse_args(argv)
    settings = get_settings()
    configure_logging(settings.log_level, json=False)
    templates = load_templates(templates_path)
    ledger = Ledger(ledger_path)
    jobs = media_jobs(templates, ledger.count())
    log.info(
        "seed media to make",
        storyboards=sum(1 for job in jobs if job.kind == "storyboard"),
        previews=sum(1 for job in jobs if job.kind == "preview"),
        preview_seconds=sum(job.seconds for job in jobs),
        tracks=sum(1 for job in jobs if job.kind == "music"),
        asset_images=sum(1 for job in jobs if job.kind == "asset"),
        estimated_usd=round(estimated_usd(jobs), 2),
    )
    if arguments.dry_run or arguments.bucket is None:
        for job in jobs:
            video_id = templates[job.seed].videoId
            log.info(
                "would make", kind=job.kind, video_id=video_id, shot=job.shot, prompt=job.prompt
            )
        return 0
    if not jobs:
        return 0
    models, upload = await connect(settings, arguments.bucket)
    failed = await generate(
        templates,
        jobs,
        models,
        upload,
        lambda written: write_templates(written, templates_path),
        lambda job: ledger.record(templates[job.seed].videoId, job),
        arguments.concurrency,
    )
    log.info("seed media done", made=len(jobs) - failed, failed=failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
