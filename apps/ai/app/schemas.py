"""Request/response models.

These Pydantic models are the contract with the TypeScript side. FastAPI turns them
into `openapi.json`, which `packages/ai-client` turns into TypeScript types. So a field
you add here shows up, typed, in `apps/api` after `bun run gen`.

Constrain every field (lengths, ranges, enums). The constraints are enforced at
runtime by Pydantic *and* end up in the OpenAPI schema as documentation. Requests are
strict: only apps/api calls this service, through the generated client, so a field it
doesn't know or a value of the wrong type is a bug on one side, refused rather than
coerced or dropped.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# For every request model (see above).
REQUEST = ConfigDict(strict=True, extra="forbid")


class HealthResponse(BaseModel):
    status: Literal["ok"]


# ------------------------------------------------------------------------------ Director
# A shot plan is what Gemini writes after watching a short: ShotPlan is both the stored
# plan's type and the API's, so every constraint here is the real contract. It is not,
# though, the planner's own output type: Vertex AI answers 400 INVALID_ARGUMENT to a
# schema with a `minItems`/`maxItems` anywhere in it, on every model and output mode
# (bisected down to exactly that keyword), so the planner's output type is
# `ShotPlanDraft`, below ShotPlan, which repeats `shots`, `steps`, `script` and
# `pose.keypoints` without a length bound; `repair_plan` turns a draft into a real
# `ShotPlan`, trimming anything that runs over `MAX_SHOTS`, `MAX_SHOT_STEPS`,
# `MAX_SCRIPT_LINES` or `MAX_POSE_KEYPOINTS` and validating the result against ShotPlan's
# own Field constraints, so a trim that still runs over fails loudly instead of being
# stored. Positions are fractions of a 9:16 portrait frame, from its top-left corner.

VIDEO_ID_PATTERN = r"^[A-Za-z0-9_-]{11}$"
MAX_SHOTS = 12
MAX_SHORT_SECONDS = 180
MAX_SHOT_SECONDS = 60
MAX_SHOT_STEPS = 10
MAX_SCRIPT_LINES = 20
MAX_POSE_KEYPOINTS = 13
# A camera frame for a scene check, base64: a 640-pixel JPEG is 40-120 kB.
MAX_FRAME_BASE64 = 400_000
# The most one plan may reserve (DIRECTOR_TOKENS_PER_PLAN's ceiling): a whole workspace's
# default monthly allowance, far past what a three-minute short needs.
MAX_PLAN_TOKENS = 2_000_000

type KeypointName = Literal[
    "nose",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]
type CameraMove = Literal[
    "static",
    "up",
    "down",
    "left",
    "right",
    "forward",
    "back",
    "orbit",
    "tilt-up",
    "tilt-down",
]
type Direction = Literal["none", "left", "right", "forward", "back", "turn-left", "turn-right"]


class Box(BaseModel):
    x: float = Field(ge=0, le=1, description="Left edge, as a fraction of the frame's width.")
    y: float = Field(ge=0, le=1, description="Top edge, as a fraction of the frame's height.")
    # Floors, not `gt=0`: Gemini's schema has no exclusive bounds, so it never sees those.
    width: float = Field(ge=0.01, le=1)
    height: float = Field(ge=0.01, le=1)


class Keypoint(BaseModel):
    name: KeypointName
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class Framing(BaseModel):
    shotSize: Literal["close-up", "medium", "full-body", "wide"]
    subject: Box = Field(description="Where the person (or the object filmed) sits in frame.")
    note: str = Field(min_length=1, max_length=160, description="How to frame it, in a phrase.")


class PhoneAngle(BaseModel):
    pitch: float = Field(
        ge=-90,
        le=90,
        description="Degrees the camera points above (+) or below (-) the horizon.",
    )
    roll: float = Field(
        ge=-45, le=45, description="Degrees the phone leans clockwise (+) from upright."
    )
    tolerance: float = Field(ge=3, le=30, description="Degrees either way that still look right.")
    height: Literal["floor", "waist", "chest", "shoulder", "eye", "overhead"]


class TargetPose(BaseModel):
    description: str = Field(min_length=1, max_length=160)
    keypoints: list[Keypoint] = Field(
        max_length=MAX_POSE_KEYPOINTS,
        description="The person's joints at the shot's key moment; empty when no one is in it.",
    )


class ShotStep(BaseModel):
    atSeconds: float = Field(ge=0, le=MAX_SHOT_SECONDS, description="From the shot's start.")
    instruction: str = Field(
        min_length=1, max_length=160, description="One imperative sentence, read out loud."
    )
    cameraMove: CameraMove


class ScriptLine(BaseModel):
    startSeconds: float = Field(ge=0, le=MAX_SHOT_SECONDS, description="From the shot's start.")
    endSeconds: float = Field(ge=0.1, le=MAX_SHOT_SECONDS)
    text: str = Field(min_length=1, max_length=240, description="What to say, word for word.")


class Shot(BaseModel):
    kind: Literal["video", "photo"]
    title: str = Field(min_length=1, max_length=80)
    purpose: str = Field(
        min_length=1,
        max_length=240,
        description="The scene's role in the story (hook, setup, reveal or payoff) and the "
        "feeling it's going for.",
    )
    sourceStartSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    sourceEndSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    durationSeconds: float = Field(
        ge=0.5,
        le=MAX_SHOT_SECONDS,
        description="How long it lasts in the edit (a photo: how long it is shown).",
    )
    camera: Literal["front", "back"]
    scene: str = Field(
        min_length=1, max_length=200, description='Where to be: "Stand near a tree".'
    )
    sceneLandmark: str | None = Field(
        max_length=40, description="The one thing the scene needs, to look for in the camera."
    )
    framing: Framing
    phoneAngle: PhoneAngle
    pose: TargetPose
    steps: list[ShotStep] = Field(min_length=1, max_length=MAX_SHOT_STEPS)
    script: list[ScriptLine] = Field(
        max_length=MAX_SCRIPT_LINES, description="Empty when nothing is said."
    )


class ShotPlan(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    format: str = Field(min_length=1, max_length=60, description='The trend, e.g. "GRWM".')
    summary: str = Field(min_length=1, max_length=400)
    audio: Literal["speech", "music", "speech-and-music", "none"]
    durationSeconds: float = Field(ge=0.5, le=MAX_SHORT_SECONDS)
    shots: list[Shot] = Field(min_length=1, max_length=MAX_SHOTS)


class TargetPoseDraft(TargetPose):
    """`TargetPose` for the planner's own output: `keypoints` carries no length bound (see
    the module comment); `repair_plan` trims it to `MAX_POSE_KEYPOINTS`."""

    keypoints: list[Keypoint] = Field(
        description="The person's joints at the shot's key moment; empty when no one is in it.",
    )


class ShotDraft(BaseModel):
    """`Shot`, as the planner answers with it: `steps`, `script` and `pose.keypoints`
    carry no length bound (see the module comment); `repair_plan` trims them, and
    synthesizes a step from the shot's `scene` when Gemini leaves `steps` empty.

    Not a subclass of `Shot`: a field whose *type* (not just its `Field` constraints)
    differs between a base model and a subclass is a mutable-attribute override
    basedpyright refuses in strict mode (unsound covariance), so `pose` and `shots`
    (`ShotPlanDraft`, below) are re-declared here instead of narrowed in an override.
    """

    kind: Literal["video", "photo"]
    title: str = Field(min_length=1, max_length=80)
    purpose: str = Field(
        min_length=1,
        max_length=240,
        description="The scene's role in the story (hook, setup, reveal or payoff) and the "
        "feeling it's going for.",
    )
    sourceStartSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    sourceEndSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    durationSeconds: float = Field(
        ge=0.5,
        le=MAX_SHOT_SECONDS,
        description="How long it lasts in the edit (a photo: how long it is shown).",
    )
    camera: Literal["front", "back"]
    scene: str = Field(
        min_length=1, max_length=200, description='Where to be: "Stand near a tree".'
    )
    sceneLandmark: str | None = Field(
        max_length=40, description="The one thing the scene needs, to look for in the camera."
    )
    framing: Framing
    phoneAngle: PhoneAngle
    pose: TargetPoseDraft
    steps: list[ShotStep]
    script: list[ScriptLine] = Field(description="Empty when nothing is said.")


class ShotPlanDraft(BaseModel):
    """`ShotPlan`, as the planner answers with it: `shots` carries no length bound (see
    the module comment, and `ShotDraft`'s on why this isn't a `ShotPlan` subclass).
    `repair_plan` turns one into a real `ShotPlan`, trimming to `MAX_SHOTS` and validating
    the result; a draft with no shots at all can't be repaired into one, and
    `repair_plan` raises for that case."""

    title: str = Field(min_length=1, max_length=120)
    format: str = Field(min_length=1, max_length=60, description='The trend, e.g. "GRWM".')
    summary: str = Field(min_length=1, max_length=400)
    audio: Literal["speech", "music", "speech-and-music", "none"]
    durationSeconds: float = Field(ge=0.5, le=MAX_SHORT_SECONDS)
    shots: list[ShotDraft]


# The database checks them too (director_plan_status_check, director_take_status_check,
# director_plan_stage_check, ...).
PlanStatus = Literal["pending", "analyzing", "ready", "failed"]
PlanSource = Literal["seed", "user"]
PlanStage = Literal["queued", "watching", "writing", "ready", "failed"]
AudioStatus = Literal["ready", "failed", "none"]
TakeStatus = Literal["pending", "reviewing", "ready", "failed"]
TakeKind = Literal["video", "photo"]
PublishStatus = Literal["none", "uploading", "published", "failed"]
# YouTube's privacy statuses, as a cut was published.
Visibility = Literal["private", "unlisted", "public"]
# A cut's title becomes its YouTube title, which YouTube caps at 100 characters.
MAX_CUT_TITLE = 100


class DirectorPlanCreate(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)


class DirectorPlanOut(BaseModel):
    id: UUID
    videoId: str
    source: PlanSource
    status: PlanStatus
    stage: PlanStage
    error: str | None
    plan: ShotPlan | None
    model: str | None
    audioStatus: AudioStatus
    audioKey: str | None = Field(
        description="The original audio's object key in storage, once captured; apps/api "
        "turns it into a short-lived link."
    )
    createdAt: datetime
    updatedAt: datetime


class DirectorLibraryOut(BaseModel):
    templates: list[DirectorPlanOut] = Field(description="The workspace's plans, newest first.")
    indexUsed: bool = Field(description="The caller has indexed their one short of their own.")


# ------------------------------------------------------------------------- the indexer
# The Cloud Run indexer's request and answer (app/indexer.py), which the worker sends and
# reads (app/indexing.py's RemoteIndexer). Both ends are this service, deployed from the
# same image, so they change together; neither is in openapi.json, which is apps/api's.


class IndexRequest(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    # For the logs: the indexer reads and writes no database.
    orgId: UUID = Field(strict=False)
    planId: UUID = Field(strict=False)
    maxTokens: int = Field(
        ge=1,
        le=MAX_PLAN_TOKENS,
        description="The run's token cap: what the worker reserved for it.",
    )


class TokenUsage(BaseModel):
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)


class AudioCapture(BaseModel):
    status: AudioStatus = Field(description='"none" when no MEDIA_BUCKET is configured.')
    objectKey: str | None = Field(max_length=200, description="Its key in MEDIA_BUCKET.")


class IndexResult(BaseModel):
    plan: ShotPlan
    model: str = Field(min_length=1, max_length=200, description="The model that wrote it.")
    audio: AudioCapture
    usage: TokenUsage = Field(description="What the run used, for the worker to count.")


class SceneCheckRequest(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    shotIndex: int = Field(ge=0, lt=MAX_SHOTS)
    image: str = Field(
        min_length=100, max_length=MAX_FRAME_BASE64, description="A JPEG camera frame, base64."
    )


# A line Director says aloud (packages/contracts' DIRECTOR_SPEECH_MAX_LENGTH): a guide, a
# cue or a script line, never a speech.
MAX_SPEECH_TEXT = 500
# Gemini's prebuilt text-to-speech voices Director may speak in (packages/contracts'
# directorVoices).
type SpeechVoice = Literal["Puck", "Kore", "Aoede", "Charon", "Sulafat"]


class SpeechRequest(BaseModel):
    model_config = REQUEST

    text: str = Field(min_length=1, max_length=MAX_SPEECH_TEXT, description="The line to say.")
    voice: SpeechVoice


class SceneLandmark(BaseModel):
    label: str = Field(min_length=1, max_length=40)
    box: Box


class SceneCheck(BaseModel):
    inPlace: bool = Field(description="The frame already looks like the shot's scene.")
    instruction: str = Field(
        min_length=1,
        max_length=160,
        description='One short spoken direction: "Move about five meters left, to the tree."',
    )
    direction: Direction
    distanceMeters: float | None = Field(ge=0, le=50)
    landmark: SceneLandmark | None = Field(
        description="Where the scene's landmark is in this frame, when it is in it."
    )
    lighting: Literal["good", "too-dark", "too-bright", "backlit"]


class DirectorTakeCreate(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    shotIndex: int = Field(ge=0, lt=MAX_SHOTS)
    # A JSON string, so not strict (strict wants a UUID object, which JSON can't carry).
    fileId: UUID = Field(strict=False)
    kind: TakeKind
    contentType: Literal["video/webm", "video/mp4", "image/jpeg"]
    sourceUrl: str = Field(
        pattern=r"^https?://",
        max_length=4_000,
        description="A presigned read of the take's file, for the review.",
    )


class TakeReview(BaseModel):
    """Gemini's review of one take: the model's output type."""

    bestStartSeconds: float | None = Field(
        ge=0, le=MAX_SHOT_SECONDS, description="Where the part worth keeping starts (video)."
    )
    bestEndSeconds: float | None = Field(ge=0.1, le=MAX_SHOT_SECONDS)
    score: int = Field(ge=0, le=100, description="How closely the take follows the shot.")
    feedback: str = Field(
        min_length=1, max_length=300, description="What worked, and the one thing to fix."
    )


class DirectorTakeOut(BaseModel):
    id: UUID
    shotIndex: int
    fileId: UUID
    kind: TakeKind
    status: TakeStatus
    error: str | None
    bestStartMs: int | None
    bestEndMs: int | None
    score: int | None
    feedback: str | None
    createdAt: datetime


class CutPick(BaseModel):
    """The take picked for one shot of a cut."""

    model_config = REQUEST

    shotIndex: int = Field(ge=0, lt=MAX_SHOTS)
    # A JSON string, so not strict (strict wants a UUID object, which JSON can't carry).
    takeId: UUID = Field(strict=False)


class DirectorCutCreate(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    title: str = Field(min_length=1, max_length=MAX_CUT_TITLE)
    # A ready director-cut-video upload of the caller's (apps/api checked it).
    fileId: UUID = Field(strict=False)
    picks: list[CutPick] = Field(min_length=1, max_length=MAX_SHOTS)


class DirectorCutOut(BaseModel):
    id: UUID
    planId: UUID
    videoId: str
    templateTitle: str = Field(description="The plan's title.")
    title: str
    picks: list[CutPick]
    fileId: UUID
    durationMs: int = Field(ge=0)
    publishStatus: PublishStatus
    youtubeVideoId: str | None
    visibility: Visibility | None
    createdAt: datetime


# ------------------------------------------------------------------------- publishing
# The YouTube post for a cut: Gemini drafts it (PublishCopyDraft, the model's output
# type) and app/publish_copy.py tidies the draft into PublishCopy, which is what apps/api's
# contract accepts (packages/contracts src/api/publish.ts). Its limits are that
# contract's: YouTube's 100-character title less the " #Shorts" apps/api adds, and room
# in YouTube's 5,000-byte description for the hashtags, credits and the original's link.
MAX_PUBLISH_TITLE = 91
MAX_PUBLISH_DESCRIPTION = 3_000
MAX_PUBLISH_CREDITS = 300
MAX_PUBLISH_HASHTAGS = 15
MAX_PUBLISH_HASHTAG = 40
# YouTube's longest description, in UTF-8 bytes, hashtags, credits and link included.
YOUTUBE_DESCRIPTION_MAX_BYTES = 5_000


class PublishOriginal(BaseModel):
    """The original Short as YouTube shows it, for the credits."""

    model_config = REQUEST

    title: str = Field(min_length=1, max_length=200)
    channel: str = Field(min_length=1, max_length=200)


class PublishCopyRequest(BaseModel):
    model_config = REQUEST

    # A JSON string, so not strict (strict wants a UUID object, which JSON can't carry).
    cutId: UUID = Field(strict=False)
    original: PublishOriginal | None = Field(
        description="The original Short, when YouTube still shows it."
    )


class PublishCopyDraft(BaseModel):
    """Gemini's draft of the post: the model's output type. No length bounds on the list
    (Vertex AI refuses a schema with minItems/maxItems; see the top of this module):
    app/publish_copy.py holds the draft to PublishCopy's limits instead."""

    title: str = Field(description="A catchy title, at most 80 characters, without hashtags.")
    description: str = Field(description="Two or three short sentences, without links.")
    hashtags: list[str] = Field(description="Three to eight single words, without the #.")
    credits: str = Field(description="One line crediting the original creator.")


class PublishCopy(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_PUBLISH_TITLE)
    description: str = Field(max_length=MAX_PUBLISH_DESCRIPTION)
    hashtags: list[Annotated[str, Field(min_length=1, max_length=MAX_PUBLISH_HASHTAG)]] = Field(
        max_length=MAX_PUBLISH_HASHTAGS, description="Single words, without the #."
    )
    credits: str = Field(max_length=MAX_PUBLISH_CREDITS)


# ------------------------------------------------------------------------- clipping
# Director's continuous recording (packages/contracts src/recording.ts): an attempt at a
# shot, marked in a session's footage, cut into a take of its own (app/clipping.py). The
# footage is a part's slices from its first, which the caller (apps/worker) signs reads
# of: this service has no storage credentials. Times are the part's own clock, in
# milliseconds. Bounds are that contract's: 150 slices of at most 15 seconds a part.
MAX_PART_SLICES = 150
MAX_PART_MS = 21 * 60_000
MAX_SLICE_MS = 15_000
MAX_CLIP_PAUSES = 200


class ClipSlice(BaseModel):
    model_config = REQUEST

    url: str = Field(
        pattern=r"^https?://", max_length=4_000, description="A presigned read of the slice."
    )
    startMs: int = Field(ge=0, le=MAX_PART_MS)
    durationMs: int = Field(gt=0, le=MAX_SLICE_MS)


class ClipPause(BaseModel):
    """A stretch nothing was recorded: no take is ever cut across one."""

    model_config = REQUEST

    startMs: int = Field(ge=0, le=MAX_PART_MS)
    endMs: int | None = Field(ge=0, le=MAX_PART_MS, description="None: to the part's end.")


class ClipRequest(BaseModel):
    model_config = REQUEST

    # A JSON string, so not strict (strict wants a UUID object, which JSON can't carry).
    attemptId: UUID = Field(strict=False, description="For the logs.")
    contentType: Literal["video/webm", "video/mp4"]
    slices: list[ClipSlice] = Field(
        min_length=1, max_length=MAX_PART_SLICES, description="The part's, from its first."
    )
    startMs: int = Field(ge=0, le=MAX_PART_MS, description="Director's start mark.")
    endMs: int | None = Field(
        ge=0, le=MAX_PART_MS, description="Director's end mark; None: to the footage's end."
    )
    pauses: list[ClipPause] = Field(max_length=MAX_CLIP_PAUSES)
