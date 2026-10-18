"""Makes the 6 seed templates' media with Google's generative models on Vertex AI, and
records it in packages/contracts/src/director-seeds.json:

- a storyboard card per shot, drawn by Nano Banana (`STORYBOARD_MODEL`):
  seed-media/<videoId>/shot-<n>.png
- a few seconds' preview clip per shot, by Veo (`PREVIEW_MODEL`), silent, 720p, 9:16:
  seed-media/<videoId>/shot-<n>.mp4
- a music track per seed, by Lyria (`MUSIC_MODEL`), matched to its moods and pace:
  seed-media/<videoId>/music.<the format Lyria answers with>

<n> is the shot's index in the plan (from 0, the API's `shotIndex`). Each prompt is made
only from the shot's own directions (where, the framing, who or what is in it, the
feeling it's going for, how the camera moves), never from titles, steps or script lines,
which can name a brand; anyone in a picture is a generic person, never a likeness of the
Short's creator. Run from the repo root, after `seeds:build` (which keeps the media of
any seed whose plan came out unchanged, and drops it otherwise):

    bun run --filter @repo/ai seeds:media -- --bucket <bucket> [--dry-run]

with <bucket> the Cloud Storage bucket the API serves files from (production's,
director-media-1053522546520, where the seeds' audio already is). It says how many of
each it will make and what that should cost before making any; `--dry-run` stops there
and lists every prompt. It only makes what has no key yet, writing each key into the
seed file as soon as its object is uploaded, so a run that stops halfway (or a medium
that fails) is finished by running it again; commit the file afterwards. Veo clips are
capped at `MAX_PREVIEWS` across all the seeds.

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
from google.auth.credentials import Credentials
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

from app.log import configure_logging, log
from app.schemas import Shot, ShotPlan
from app.settings import Settings, get_settings
from scripts.build_seeds import TEMPLATES_PATH, SeedTemplate, load_templates, write_templates

# The models, each checked to answer on Vertex AI on 2026-10-18: Nano Banana 2.1, Veo 3.1
# Lite and Lyria 3 Clip (about 30 seconds of music).
STORYBOARD_MODEL = "gemini-nano-banana-2.1"
PREVIEW_MODEL = "veo-3.1-lite-generate-001"
MUSIC_MODEL = "lyria-3-clip-preview"
# Veo isn't served from the "global" location the Gemini models are.
PREVIEW_LOCATION = "us-central1"
MAX_PREVIEWS = 40
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

_GENERIC_PERSON = (
    "Anyone in it is a generic, anonymous adult, not a likeness of any real or recognisable person."
)
_NO_TEXT = "No text, captions, labels, logos, brand names, watermarks or panel numbers anywhere."
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

type MediaKind = Literal["storyboard", "preview", "music"]
# A model's answer: the file's bytes and its media type.
type Media = tuple[bytes, str]
# Uploads bytes to a key in the bucket, with their media type.
type Upload = Callable[[str, bytes, str], Awaitable[None]]


class MediaModels(Protocol):
    async def storyboard(self, prompt: str) -> Media: ...
    async def preview(self, prompt: str, seconds: int) -> Media: ...
    async def music(self, prompt: str) -> Media: ...


type Connect = Callable[[Settings, str], Awaitable[tuple[MediaModels, Upload]]]


@dataclass(frozen=True)
class Job:
    """One medium to make: for the `seed`-th template, its `shot`-th shot (None: the
    seed's music), from `prompt`; a preview `seconds` long."""

    kind: MediaKind
    seed: int
    shot: int | None
    prompt: str
    seconds: int = 0


# --------------------------------------------------------------------------------- prompts


def _directions(shot: Shot) -> list[str]:
    lens = "front (selfie)" if shot.camera == "front" else "rear"
    return [
        f"Where: {shot.scene}",
        f"Framing: a {shot.framing.shotSize} shot on the phone's {lens} camera, held at "
        f"{shot.phoneAngle.height} height. {shot.framing.note}",
        f"In it: {shot.pose.description}",
        f"Feeling: {shot.purpose}",
    ]


def _camera(shot: Shot) -> str:
    moves = list(
        dict.fromkeys(_MOVES[s.cameraMove] for s in shot.steps if s.cameraMove != "static")
    )
    return f"The camera moves {', then '.join(moves)}." if moves else "The camera holds still."


def storyboard_prompt(shot: Shot) -> str:
    return "\n".join(
        [
            "A single storyboard frame for one shot of a vertical 9:16 phone video, drawn as "
            "a clean pencil and grey-marker sketch on white paper.",
            *_directions(shot),
            _GENERIC_PERSON,
            _NO_TEXT,
        ]
    )


def preview_seconds(shot: Shot) -> Literal[4, 6]:
    """Veo makes 4, 6 or 8 seconds: the shortest that shows a short shot, and at most 6
    (a preview, not the shot itself)."""
    return 4 if shot.durationSeconds <= 5 else 6


def preview_prompt(shot: Shot, seconds: int) -> str:
    return "\n".join(
        [
            f"A {seconds}-second vertical 9:16 phone video, handheld, in natural light.",
            *_directions(shot),
            _camera(shot),
            _GENERIC_PERSON,
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


def media_jobs(templates: list[SeedTemplate], max_previews: int = MAX_PREVIEWS) -> list[Job]:
    """Every medium the seeds have no key for yet, in the seed file's order; previews only
    up to `max_previews` across all of them, counting those already made."""
    previews_left = max_previews - sum(
        1 for template in templates for shot in template.plan.shots if shot.previewKey
    )
    held_back = 0
    jobs: list[Job] = []
    for seed, template in enumerate(templates):
        for index, shot in enumerate(template.plan.shots):
            if shot.storyboardKey is None:
                jobs.append(Job("storyboard", seed, index, storyboard_prompt(shot)))
            if shot.previewKey is None and previews_left <= 0:
                held_back += 1
            elif shot.previewKey is None:
                seconds = preview_seconds(shot)
                jobs.append(Job("preview", seed, index, preview_prompt(shot, seconds), seconds))
                previews_left -= 1
        if template.plan.musicKey is None:
            jobs.append(Job("music", seed, None, music_prompt(template.plan)))
    if held_back:
        log.warning("previews held back at the cap", held_back=held_back, cap=max_previews)
    return jobs


def _price(job: Job) -> float:
    if job.kind == "preview":
        return job.seconds * PREVIEW_USD_PER_SECOND
    return STORYBOARD_USD if job.kind == "storyboard" else MUSIC_USD


def estimated_usd(jobs: list[Job]) -> float:
    return sum(_price(job) for job in jobs)


# -------------------------------------------------------------------------------- the run


async def _make(template: SeedTemplate, job: Job, models: MediaModels, upload: Upload) -> None:
    if job.kind == "storyboard":
        data, media_type = await models.storyboard(job.prompt)
    elif job.kind == "preview":
        data, media_type = await models.preview(job.prompt, job.seconds)
    else:
        data, media_type = await models.music(job.prompt)
    extension = _EXTENSIONS.get(media_type)
    if extension is None:
        raise ValueError(f"no file extension for a {job.kind} of type {media_type}")
    name = "music" if job.shot is None else f"shot-{job.shot}"
    key = f"seed-media/{template.videoId}/{name}.{extension}"
    await upload(key, data, media_type)
    if job.shot is None:
        template.plan.musicKey = key
    elif job.kind == "storyboard":
        template.plan.shots[job.shot].storyboardKey = key
    else:
        template.plan.shots[job.shot].previewKey = key


async def generate(
    templates: list[SeedTemplate],
    jobs: list[Job],
    models: MediaModels,
    upload: Upload,
    save: Callable[[list[SeedTemplate]], None],
    concurrency: int = 3,
) -> int:
    """Makes every job, `concurrency` at a time, saving the templates after each one
    lands; returns how many failed (logged, their keys left unset for the next run)."""
    slots = asyncio.Semaphore(concurrency)

    async def run(job: Job) -> bool:
        template = templates[job.seed]
        async with slots:
            try:
                await _make(template, job, models, upload)
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
        poll_seconds: float = POLL_SECONDS,
        retry_seconds: float = QUOTA_RETRY_SECONDS,
    ) -> None:
        # Held for the whole run: google-genai closes a client's connections as soon as
        # nothing holds the client, and its `models` alone doesn't.
        self._images = images
        self._content: _ContentModels = images.aio.models
        self._videos = videos
        self._poll_seconds = poll_seconds
        self._retry_seconds = retry_seconds

    async def _retried[T](self, call: Callable[[], Awaitable[T]]) -> T:
        """`call`, tried again after a wait while Vertex answers 429: a model's quota per
        minute is spent (Veo's is a few requests), which a wait fixes. Any other refusal,
        or a quota still spent after `QUOTA_ATTEMPTS`, fails at once."""
        attempt, wait = 1, self._retry_seconds
        while True:
            try:
                return await call()
            except genai_errors.ClientError as error:
                if error.code != HTTPStatus.TOO_MANY_REQUESTS or attempt == QUOTA_ATTEMPTS:
                    raise
                log.info("quota spent, waiting", attempt=attempt, seconds=wait)
                await asyncio.sleep(wait)
                attempt, wait = attempt + 1, wait * 2

    async def storyboard(self, prompt: str) -> Media:
        config = GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=ImageConfig(aspect_ratio="9:16", image_size="1K"),
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


def gcs_upload(bucket: str, credentials: Credentials, project: str) -> Upload:
    client = storage.Client(project=project, credentials=credentials)

    def put(key: str, data: bytes, content_type: str) -> None:
        client.bucket(bucket).blob(key).upload_from_string(  # pyright: ignore[reportUnknownMemberType]  # untyped client
            data, content_type=content_type
        )

    async def upload(key: str, data: bytes, content_type: str) -> None:
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
    # developer's machine; its token lasts an hour, and a run takes minutes.
    credentials = UserCredentials(await access_token(token_command))
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
            credentials=credentials,
            http_options=http_options,
        )

    models = VertexMediaModels(
        client(settings.vertex_location), client(PREVIEW_LOCATION), poll_seconds, retry_seconds
    )
    return models, gcs_upload(bucket, credentials, project)


# ---------------------------------------------------------------------------- the command


class _Arguments(argparse.Namespace):
    bucket: str = ""
    dry_run: bool = False
    concurrency: int = 3


def parse_args(argv: Sequence[str] | None) -> _Arguments:
    parser = argparse.ArgumentParser(description="Make the seed templates' media.")
    parser.add_argument("--bucket", required=True, help="the Cloud Storage bucket to write to")
    parser.add_argument("--dry-run", action="store_true", help="say what it would make, and stop")
    parser.add_argument("--concurrency", type=int, default=3, help="media made at once")
    return parser.parse_args(argv, namespace=_Arguments())


async def main(
    argv: Sequence[str] | None = None,
    templates_path: Path = TEMPLATES_PATH,
    connect: Connect = connect_vertex,
) -> int:
    arguments = parse_args(argv)
    settings = get_settings()
    configure_logging(settings.log_level, json=False)
    templates = load_templates(templates_path)
    jobs = media_jobs(templates)
    log.info(
        "seed media to make",
        storyboards=sum(1 for job in jobs if job.kind == "storyboard"),
        previews=sum(1 for job in jobs if job.kind == "preview"),
        preview_seconds=sum(job.seconds for job in jobs),
        tracks=sum(1 for job in jobs if job.kind == "music"),
        estimated_usd=round(estimated_usd(jobs), 2),
    )
    if arguments.dry_run:
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
        arguments.concurrency,
    )
    log.info("seed media done", made=len(jobs) - failed, failed=failed)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
