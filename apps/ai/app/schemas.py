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
# What a template needs beyond the member's own filming (packages/contracts' director.ts
# mirrors these): at most one asset per image a video may have made (12, the image limit
# per video), and room for a busy edit (captions, a layout, overlays, cuts).
MAX_ASSETS = 12
MAX_EDITS = 40
MAX_ASSET_TEXT_LINES = 12
MAX_ASSET_ID = 40
# An asset's id: lowercase words joined by hyphens ("chart", "end-card"). It names the
# asset's default image in storage too (app/assets.py), so nothing else gets through.
ASSET_ID_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"
# A colour on an edit: "#RRGGBB".
COLOR_PATTERN = r"^#[0-9A-Fa-f]{6}$"
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
# What a shot's take is: a clip or a photo.
type ShotKind = Literal["video", "photo"]
# What the edit uses of it: the member on camera (as every shot was before modes), only
# their voice (a voice-over, the picture an asset or B-roll: a video take), or nothing,
# the asset taking its place (an end card, a full-screen graphic: a photo take stands
# in until the editor places the asset). Beside `kind` rather than in it: a new value of
# `kind` would break the API's clients, which a new field doesn't.
type ShotMode = Literal["on-camera", "voice-over", "asset"]
type AssetKind = Literal[
    "image", "cutout", "text-card", "background", "broll", "music", "sfx", "end-card"
]
# Where a slot's piece comes from by default: made with AI from the reference, stock, or
# the member's own upload.
type AssetSource = Literal["create", "stock", "upload"]
# The shapes Nano Banana draws in, and half of a vertical split screen (9:8).
type AspectRatio = Literal["9:16", "3:4", "4:5", "1:1", "9:8", "5:4", "4:3", "16:9"]
type EditType = Literal[
    "layout", "overlay", "grade", "text", "transition", "speed", "end-card", "gap"
]
# The edits' enums are plain aliases, not `type` statements, so a schema inlines them:
# a nullable one is then `anyOf: [{enum}, {null}]`, the shape Vertex AI has always been
# sent, rather than a `$ref` inside an `anyOf` (tests/test_planner_schema.py).
LayoutKind = Literal["full", "split", "picture-in-picture"]
Entrance = Literal["cut", "fade", "slide", "pop", "draw"]
Mark = Literal["circle", "underline", "arrow", "box", "highlight", "tick", "cross"]
Grade = Literal["black-and-white", "warm", "cool", "high-contrast", "vintage", "vivid"]
GradeTarget = Literal["all", "camera", "assets"]
TextStyle = Literal["title", "lower-third", "captions", "label", "callout"]
TextPosition = Literal["top", "middle", "bottom", "between-halves"]
CaptionStyle = Literal["word-by-word", "line", "boxed"]
TransitionKind = Literal["cut", "match-cut", "whip", "fade", "zoom", "spin", "glitch"]
Easing = Literal["linear", "ease-in", "ease-out", "ease-in-out"]


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
    kind: ShotKind
    mode: ShotMode = Field(
        default="on-camera",
        description="on-camera: the viewer films it; voice-over: only their voice is used; "
        "asset: nothing is filmed, an asset takes its place.",
    )
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


# --------------------------------------------------------------------- assets and edits
# What a Short needs beyond the member filming themselves: the pieces it shows (a chart
# under the speaker, a headline card, an end card, B-roll, music) and the editing done
# over the footage (a split screen, captions, a grade, overlays, transitions). Times are
# seconds of the original, like a shot's source range: the editor maps them onto the
# member's takes through the shots' source ranges.
#
# Director never takes the original's pictures: an asset's reference describes the
# original's piece precisely enough to make a fresh one (docs/director.md's rule against
# downloading YouTube's pictures, and the creator's rights), and its prompt is what Nano
# Banana makes the default from (app/assets.py) and what the Create tab starts from.


# The drafts' docstrings go to Gemini as their schema's description, so they say what
# the thing is and nothing else; why each differs from its stored model is here instead.
# AssetReferenceDraft's `text` and `brands` carry no length bound (see the module
# comment): `repair_plan` trims them.
class AssetReferenceDraft(BaseModel):
    """The original's piece, described precisely enough to recreate its look."""

    subject: str = Field(min_length=1, max_length=300, description="What it shows.")
    composition: str = Field(
        min_length=1, max_length=300, description="Its layout and framing: what sits where."
    )
    style: str = Field(
        min_length=1,
        max_length=200,
        description='How it is made: "flat vector infographic", "photo", "hand-drawn".',
    )
    palette: str = Field(
        min_length=1, max_length=200, description='Its colours, or "black and white".'
    )
    blackAndWhite: bool
    aspectRatio: AspectRatio
    text: list[str] = Field(
        description="Every line of text on it, word for word; empty when there is none."
    )
    brands: list[str] = Field(
        description="Every brand, product or company name, logo text, handle, website, and "
        "the creator's or channel's own name on it, each as written; empty when none."
    )
    mood: str = Field(min_length=1, max_length=160)


class AssetReference(AssetReferenceDraft):
    """The original's piece, described precisely enough to recreate its look."""

    text: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        max_length=MAX_ASSET_TEXT_LINES,
        description="Every line of text on it, word for word; empty when there is none.",
    )
    # The original's own branding: never drawn into the member's version (app/assets.py).
    # A plan written before it reads with none.
    brands: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list[str], max_length=MAX_ASSET_TEXT_LINES
    )


class _AssetFields(BaseModel):
    """What `Asset` and the planner's `AssetDraft` share: everything but its id's pattern
    and its reference (see `ShotDraft` on why neither subclasses the other)."""

    id: str = Field(
        min_length=1,
        max_length=MAX_ASSET_ID,
        description='Lowercase words joined by hyphens, unique in the plan: "chart".',
    )
    kind: AssetKind
    title: str = Field(
        min_length=1, max_length=80, description='A short name for it: "The archetypes chart".'
    )
    role: str = Field(
        min_length=1, max_length=240, description="What it does in the Short, and where it sits."
    )
    description: str = Field(
        min_length=1, max_length=600, description="The original's piece, in a sentence or two."
    )
    prompt: str = Field(
        min_length=1,
        max_length=1_500,
        description="What to ask an image model for to make a fresh one in the original's "
        "style, in English, with any text on it in quotes.",
    )
    sourceStartSeconds: float = Field(
        ge=0, le=MAX_SHORT_SECONDS, description="When it first shows in the original."
    )
    sourceEndSeconds: float = Field(
        ge=0, le=MAX_SHORT_SECONDS, description="When it's last seen in the original."
    )
    defaultSource: AssetSource
    personalisable: bool = Field(description="The member could make it about their own topic.")
    ask: str | None = Field(
        max_length=160,
        description='What to ask the member for when it is theirs: "a photo of your dog".',
    )
    secondScreen: bool = Field(description="The original shows it on another screen in shot.")


# `repair_plan` makes an AssetDraft's id one the pattern allows (and unique), fits its
# timing into the Short, and trims its text.
class AssetDraft(_AssetFields):
    """Something the Short shows that the viewer can't film themselves."""

    reference: AssetReferenceDraft


class Asset(_AssetFields):
    id: str = Field(min_length=1, max_length=MAX_ASSET_ID, pattern=ASSET_ID_PATTERN)
    sourceEndSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    reference: AssetReference


# An EditDraft is one flat shape for every edit type: `repair_plan` turns it into its
# type's own model (`Edit`), keeps it inside the Short and in order, and drops one it
# can't make whole. Every field is required and nullable with no default, and the box is
# four numbers rather than a nested object, so the schema Vertex AI is sent keeps to
# what it has always accepted from this service (`sceneLandmark`'s shape) and stays
# small (tests/test_planner_schema.py).
class EditDraft(BaseModel):
    """One edit: fill only the fields its type uses (each field names its types), null
    the rest."""

    type: EditType
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS, description="In the original.")
    endSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    layout: LayoutKind | None = Field(description="layout")
    assetId: str | None = Field(max_length=MAX_ASSET_ID, description="layout, overlay, end-card")
    cameraOn: Literal["top", "bottom"] | None = Field(
        description="layout: split, where the camera picture goes"
    )
    cameraShare: float | None = Field(
        description="layout: split, the camera's share of the height (0.5: half)"
    )
    boxX: float | None = Field(
        description="layout: picture-in-picture; overlay: the box's left edge (0 to 1)"
    )
    boxY: float | None = Field(description="its top edge (0 to 1)")
    boxWidth: float | None = Field(description="its width (0 to 1)")
    boxHeight: float | None = Field(description="its height (0 to 1)")
    inset: Literal["camera", "asset"] | None = Field(
        description="layout: picture-in-picture, what sits in the box"
    )
    mark: Mark | None = Field(description="overlay, when it's not an asset")
    color: str | None = Field(description='overlay, text: "#RRGGBB"')
    entry: Entrance | None = Field(description="overlay")
    exit: Entrance | None = Field(description="overlay")
    grade: Grade | None = Field(description="grade")
    target: GradeTarget | None = Field(description="grade")
    style: TextStyle | None = Field(description="text")
    text: str | None = Field(max_length=240, description="text (null for captions), end-card")
    position: TextPosition | None = Field(description="text")
    captionStyle: CaptionStyle | None = Field(description="text: captions")
    highlightColor: str | None = Field(description='text: "#RRGGBB"')
    transition: TransitionKind | None = Field(description="transition")
    anchor: str | None = Field(max_length=120, description="transition: a match cut's anchor")
    fromRate: float | None = Field(description="speed: 1 is normal speed")
    toRate: float | None = Field(description="speed")
    easing: Easing | None = Field(description="speed")
    description: str | None = Field(
        max_length=240, description="gap: what the B-roll or cutaway shows"
    )


class LayoutEdit(BaseModel):
    """How the frame is shared: the camera full frame (or an asset, for a voice-over), a
    split with the camera on top or at the bottom taking `cameraShare` of the height and
    the asset in the rest, or picture-in-picture with the `inset` in `box`."""

    type: Literal["layout"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    layout: LayoutKind
    assetId: str | None = Field(max_length=MAX_ASSET_ID)
    cameraOn: Literal["top", "bottom"] | None
    cameraShare: float | None = Field(ge=0.2, le=0.8)
    box: Box | None
    inset: Literal["camera", "asset"] | None


class OverlayEdit(BaseModel):
    """Something drawn over the frame: an asset, or a mark (a circle, an underline)."""

    type: Literal["overlay"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    assetId: str | None = Field(max_length=MAX_ASSET_ID)
    mark: Mark | None
    color: str | None = Field(pattern=COLOR_PATTERN)
    box: Box
    entry: Entrance
    exit: Entrance


class GradeEdit(BaseModel):
    type: Literal["grade"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    grade: Grade
    target: GradeTarget


class TextEdit(BaseModel):
    """Words on screen. Captions carry no text of their own: they're the member's words."""

    type: Literal["text"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    style: TextStyle
    text: str | None = Field(min_length=1, max_length=240)
    position: TextPosition
    captionStyle: CaptionStyle | None
    color: str | None = Field(pattern=COLOR_PATTERN)
    highlightColor: str | None = Field(pattern=COLOR_PATTERN)


class TransitionEdit(BaseModel):
    """Into whatever starts at `startSeconds`, lasting until `endSeconds`."""

    type: Literal["transition"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    transition: TransitionKind
    anchor: str | None = Field(
        min_length=1, max_length=120, description="A match cut's anchor: what lines up."
    )


class SpeedEdit(BaseModel):
    type: Literal["speed"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    fromRate: float = Field(ge=0.1, le=8)
    toRate: float = Field(ge=0.1, le=8)
    easing: Easing


class EndCardEdit(BaseModel):
    type: Literal["end-card"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    assetId: str | None = Field(max_length=MAX_ASSET_ID)
    text: str | None = Field(min_length=1, max_length=240)


class GapEdit(BaseModel):
    """A moment to fill with B-roll or a cutaway: what it shows, for as long as it lasts."""

    type: Literal["gap"]
    startSeconds: float = Field(ge=0, le=MAX_SHORT_SECONDS)
    endSeconds: float = Field(ge=0.1, le=MAX_SHORT_SECONDS)
    description: str = Field(min_length=1, max_length=240)


type Edit = Annotated[
    LayoutEdit
    | OverlayEdit
    | GradeEdit
    | TextEdit
    | TransitionEdit
    | SpeedEdit
    | EndCardEdit
    | GapEdit,
    Field(discriminator="type"),
]


class ShotPlan(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    format: str = Field(min_length=1, max_length=60, description='The trend, e.g. "GRWM".')
    summary: str = Field(min_length=1, max_length=400)
    audio: Literal["speech", "music", "speech-and-music", "none"]
    durationSeconds: float = Field(ge=0.5, le=MAX_SHORT_SECONDS)
    shots: list[Shot] = Field(min_length=1, max_length=MAX_SHOTS)
    # A plan written before assets and edits existed reads with neither.
    assets: list[Asset] = Field(default_factory=list[Asset], max_length=MAX_ASSETS)
    edits: list[Edit] = Field(default_factory=list[Edit], max_length=MAX_EDITS)


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

    kind: ShotKind
    mode: ShotMode = Field(
        description="on-camera: the viewer films it; voice-over: only their voice is used; "
        "asset: nothing is filmed, an asset takes its place.",
    )
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
    # Required, with no default, like every draft field (EditDraft's docstring says why).
    assets: list[AssetDraft] = Field(
        description="What the Short shows that the viewer can't film themselves; empty when "
        "there's nothing."
    )
    edits: list[EditDraft] = Field(
        description="The editing over the footage, in order; empty when there's none."
    )


# The database checks them too (director_plan_status_check, director_take_status_check,
# director_plan_stage_check, ...).
PlanStatus = Literal["pending", "analyzing", "ready", "failed"]
PlanSource = Literal["seed", "user"]
PlanStage = Literal["queued", "watching", "writing", "ready", "failed"]
AudioStatus = Literal["ready", "failed", "none"]
TakeStatus = Literal["pending", "reviewing", "ready", "failed"]
TakeKind = Literal["video", "photo"]
# A default asset image: queued with the plan, being drawn, stored, or given up on
# (director_asset_status_check).
AssetImageStatus = Literal["pending", "generating", "ready", "failed"]
PublishStatus = Literal["none", "uploading", "published", "failed"]
# YouTube's privacy statuses, as a cut was published.
Visibility = Literal["private", "unlisted", "public"]
# A cut's title becomes its YouTube title, which YouTube caps at 100 characters.
MAX_CUT_TITLE = 100


class DirectorPlanCreate(BaseModel):
    model_config = REQUEST

    videoId: str = Field(pattern=VIDEO_ID_PATTERN)


class AssetImageOut(BaseModel):
    """The default image made for one of a plan's assets (app/assets.py)."""

    assetId: str = Field(min_length=1, max_length=MAX_ASSET_ID, pattern=ASSET_ID_PATTERN)
    status: AssetImageStatus
    objectKey: str | None = Field(
        max_length=200,
        description="Its key in MEDIA_BUCKET once it's ready; apps/api turns it into a "
        "short-lived link.",
    )


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
    # Optional in the contract: an API from before asset images still reads the plan.
    assetImages: list[AssetImageOut] = Field(
        default_factory=list[AssetImageOut],
        max_length=MAX_ASSETS,
        description="The default images made for the plan's assets, on a plan read on its "
        "own (getDirectorPlan); empty in the library and for a seeded template, whose are "
        "committed with it.",
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


# What Director may point at on the member's camera (packages/contracts'
# DIRECTOR_LOCATE_TARGET_MAX_LENGTH): a thing, named in a few words.
MAX_LOCATE_TARGET = 120
MAX_LOCATE_LABEL = 40


class LocateRequest(BaseModel):
    model_config = REQUEST

    target: str = Field(
        min_length=1,
        max_length=MAX_LOCATE_TARGET,
        description='What to find, in Director\'s words: "the window behind you".',
    )
    image: str = Field(
        min_length=100, max_length=MAX_FRAME_BASE64, description="A JPEG camera frame, base64."
    )


# One of Gemini's 0 to 1000 coordinates, the scale it is trained to give boxes on.
type Thousandth = Annotated[int, Field(ge=0, le=1000)]


class LocateDraft(BaseModel):
    """Gemini's answer to a locate: in its own box format, which `Located` turns into the
    fractions every other frame position in Director uses."""

    found: bool = Field(
        description="The target is clearly in this frame. False when it isn't, or unsure."
    )
    label: str = Field(
        min_length=1,
        max_length=MAX_LOCATE_LABEL,
        description='What it is, in two or three plain words for the person: "your window".',
    )
    box_2d: list[Thousandth] | None = Field(
        min_length=4,
        max_length=4,
        description="[ymin, xmin, ymax, xmax] of the target, from 0 to 1000; null if not found.",
    )


class Located(BaseModel):
    """Where a target is in the frame it was looked for in, or that it isn't there."""

    found: bool
    label: str = Field(min_length=1, max_length=MAX_LOCATE_LABEL)
    box: Box | None = Field(
        description="As fractions of the frame from its top-left; null when not found."
    )


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
