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
from typing import Literal
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


# The database checks them too (director_plan_status_check, director_take_status_check).
PlanStatus = Literal["pending", "analyzing", "ready", "failed"]
TakeStatus = Literal["pending", "reviewing", "ready", "failed"]
TakeKind = Literal["video", "photo"]


class DirectorPlanCreate(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)


class DirectorPlanOut(BaseModel):
    id: UUID
    videoId: str
    status: PlanStatus
    error: str | None
    plan: ShotPlan | None
    model: str | None
    createdAt: datetime
    updatedAt: datetime


class SceneCheckRequest(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)
    shotIndex: int = Field(ge=0, lt=MAX_SHOTS)
    image: str = Field(
        min_length=100, max_length=MAX_FRAME_BASE64, description="A JPEG camera frame, base64."
    )


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
