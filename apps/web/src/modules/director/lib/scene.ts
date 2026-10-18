/**
 * What the finished video shows at a moment of the edit, from the plan's edit list: the
 * frame's layout (the camera full frame, a split with an asset, picture-in-picture), the
 * asset in its box, the grades, the overlays and words, the end card, and a gap's B-roll.
 * The edit list's times are the original's; they're moved onto the edit's clock through
 * the shots' source ranges, so a split that covered the original's talking section covers
 * the member's talking section, however long their takes are.
 *
 * Pure, so the render (lib/stitch.ts, lib/compose.ts) and its tests read the same answer.
 * Boxes are fractions of the 9:16 frame from its top-left.
 */
import type { FrameBox, ShotPlan } from "@repo/contracts/api";
import type { Clip } from "./edit";
import { FILTERS } from "./slot-preview";

type Edit = ShotPlan["edits"][number];
type Asset = ShotPlan["assets"][number];
type EditOf<T extends Edit["type"]> = Extract<Edit, { type: T }>;

export const FULL: FrameBox = { x: 0, y: 0, width: 1, height: 1 };

/** A gap's slot id: the nth `gap` edit of the plan, from 1 (the AI service names them alike). */
export const gapSlotId = (n: number) => `gap-${n}`;
/** A skipped shot's slot id: the nth shot, from 1. */
export const shotSlotId = (n: number) => `shot-${n}`;

/** Where a moment of the original lands on the edit's clock. */
export function editTime(clips: readonly Clip[], source: number): number {
  for (const clip of clips) {
    const { sourceStartSeconds: start, sourceEndSeconds: end } = clip.shot;
    if (source < start) {
      // Between two shots of the original: the next shot's start.
      return clip.at;
    }
    if (source < end) {
      return clip.at + ((source - start) / Math.max(0.1, end - start)) * clip.seconds;
    }
  }
  const last = clips.at(-1);
  return last ? last.at + last.seconds : 0;
}

/** An edit's span on the edit's clock. */
export interface Span {
  start: number;
  end: number;
}

export const spanOf = (
  clips: readonly Clip[],
  edit: { startSeconds: number; endSeconds: number },
) => ({
  start: editTime(clips, edit.startSeconds),
  end: editTime(clips, edit.endSeconds),
});

const within = (span: Span, at: number) => at >= span.start && at < span.end;

export interface Placed {
  assetId: string;
  box: FrameBox;
  fit: "cover" | "contain";
  /** 0 to 1: how far in its entry or exit it is (1 shown fully). */
  shown: number;
}

export interface Words {
  text: string;
  style: EditOf<"text">["style"];
  position: EditOf<"text">["position"];
  color: string | null;
  highlight: string | null;
  shown: number;
}

export interface Mark {
  mark: NonNullable<EditOf<"overlay">["mark"]>;
  box: FrameBox;
  color: string | null;
  /** 0 to 1: how much of it is drawn on. */
  drawn: number;
}

export interface Scene {
  /** Where the member's picture goes; null when it isn't seen (a voice-over, an asset shot). */
  camera: FrameBox | null;
  /** The asset sharing (or taking) the frame. */
  asset: Placed | null;
  /** CSS/canvas filters for the camera and for the assets. */
  cameraFilter: string | null;
  assetFilter: string | null;
  /** A B-roll gap playing over the camera: its slot and how far into it (seconds). */
  gap: { slotId: string; seconds: number; length: number } | null;
  overlays: Placed[];
  marks: Mark[];
  words: Words[];
  /** The closing card: its asset (if one is chosen or drawn) and its words. */
  endCard: { assetId: string | null; text: string | null } | null;
  /** Where the captions' middle sits, as a fraction of the height. */
  captionsY: number;
}

// Graphics carrying words are fitted whole rather than cropped (as slot-preview does).
const CONTAINED = new Set<Asset["kind"]>(["text-card", "end-card"]);
/** How long an entry or exit takes, in seconds. */
export const EASE_SECONDS = 0.35;

function easing(span: Span, at: number, entry: string, exit: string) {
  const inFor = entry === "cut" ? 1 : Math.min(1, (at - span.start) / EASE_SECONDS);
  const outFor = exit === "cut" ? 1 : Math.min(1, (span.end - at) / EASE_SECONDS);
  return Math.max(0, Math.min(inFor, outFor));
}

function layoutBoxes(edit: EditOf<"layout">): { camera: FrameBox | null; asset: FrameBox | null } {
  if (edit.layout === "split") {
    const share = edit.cameraShare ?? 0.5;
    return edit.cameraOn === "bottom"
      ? {
          camera: { x: 0, y: 1 - share, width: 1, height: share },
          asset: { x: 0, y: 0, width: 1, height: 1 - share },
        }
      : {
          camera: { x: 0, y: 0, width: 1, height: share },
          asset: { x: 0, y: share, width: 1, height: 1 - share },
        };
  }
  if (edit.layout === "picture-in-picture" && edit.box) {
    return edit.inset === "camera"
      ? { camera: edit.box, asset: FULL }
      : { camera: FULL, asset: edit.box };
  }
  // Full: the asset takes the frame when the layout names one, else the camera does.
  return edit.assetId ? { camera: null, asset: FULL } : { camera: FULL, asset: null };
}

const CAPTION_Y: Record<EditOf<"text">["position"], number> = {
  top: 0.18,
  middle: 0.5,
  bottom: 0.78,
  "between-halves": 0.5,
};
/** The captions' default place: over the chest, clear of YouTube's buttons. */
export const CAPTIONS_Y = 0.64;

/** The plan's asset for a voice-over or asset shot with no layout of its own: the one it overlaps. */
function assetOfShot(plan: ShotPlan, clip: Clip): Asset | undefined {
  const { sourceStartSeconds: start, sourceEndSeconds: end } = clip.shot;
  return plan.assets.find(
    (asset) =>
      asset.kind !== "music" &&
      asset.kind !== "sfx" &&
      asset.kind !== "broll" &&
      asset.sourceStartSeconds < end &&
      asset.sourceEndSeconds > start,
  );
}

function gapAt(plan: ShotPlan, clips: readonly Clip[], at: number, clip: Clip | undefined) {
  // A skipped shot is a gap for all of its length.
  if (clip && clip.state === "missing") {
    return { slotId: shotSlotId(clip.index + 1), seconds: at - clip.at, length: clip.seconds };
  }
  let n = 0;
  for (const edit of plan.edits) {
    if (edit.type !== "gap") {
      continue;
    }
    n += 1;
    const span = spanOf(clips, edit);
    if (within(span, at)) {
      return { slotId: gapSlotId(n), seconds: at - span.start, length: span.end - span.start };
    }
  }
  return null;
}

function gradeFilters(plan: ShotPlan, clips: readonly Clip[], at: number) {
  let camera: string[] = [];
  let assets: string[] = [];
  for (const edit of plan.edits) {
    if (edit.type === "grade" && within(spanOf(clips, edit), at)) {
      const filter = FILTERS[edit.grade];
      if (edit.target !== "assets") {
        camera = [...camera, filter];
      }
      if (edit.target !== "camera") {
        assets = [...assets, filter];
      }
    }
  }
  return {
    cameraFilter: camera.length > 0 ? camera.join(" ") : null,
    assetFilter: assets.length > 0 ? assets.join(" ") : null,
  };
}

function placed(plan: ShotPlan, assetId: string, box: FrameBox, shown: number): Placed {
  const asset = plan.assets.find((each) => each.id === assetId);
  return { assetId, box, fit: asset && CONTAINED.has(asset.kind) ? "contain" : "cover", shown };
}

function frameOf(plan: ShotPlan, clips: readonly Clip[], at: number, clip: Clip | undefined) {
  const layout = plan.edits.find(
    (edit): edit is EditOf<"layout"> => edit.type === "layout" && within(spanOf(clips, edit), at),
  );
  const boxes = layout ? layoutBoxes(layout) : { camera: FULL, asset: null };
  let asset = layout?.assetId && boxes.asset ? placed(plan, layout.assetId, boxes.asset, 1) : null;
  let camera = boxes.camera;
  // Only the member's voice is used, or nothing of their take: the picture is the asset.
  if (clip && clip.shot.mode !== "on-camera") {
    const own =
      asset ??
      (() => {
        const found = assetOfShot(plan, clip);
        return found ? placed(plan, found.id, FULL, 1) : null;
      })();
    if (own) {
      asset = { ...own, box: FULL };
      camera = null;
    }
  }
  return { camera, asset, layout };
}

/** What the video shows `at` seconds into the edit. */
export function sceneAt(plan: ShotPlan, clips: readonly Clip[], at: number): Scene {
  const clip = clips.find((each) => at < each.at + each.seconds) ?? clips.at(-1);
  const { camera, asset, layout } = frameOf(plan, clips, at, clip);
  const overlays: Placed[] = [];
  const marks: Mark[] = [];
  const words: Words[] = [];
  let endCard: Scene["endCard"] = null;
  let captionsY = CAPTIONS_Y;
  for (const edit of plan.edits) {
    const span = spanOf(clips, edit);
    if (!within(span, at)) {
      continue;
    }
    if (edit.type === "overlay") {
      const shown = easing(span, at, edit.entry, edit.exit);
      if (edit.assetId) {
        overlays.push(placed(plan, edit.assetId, edit.box, shown));
      } else if (edit.mark) {
        const drawn = edit.entry === "draw" ? Math.min(1, (at - span.start) / 0.6) : 1;
        marks.push({
          mark: edit.mark,
          box: edit.box,
          color: edit.color,
          drawn: Math.min(drawn, shown),
        });
      }
    } else if (edit.type === "text") {
      if (edit.style === "captions") {
        captionsY =
          edit.position === "between-halves" && layout?.layout === "split" && camera
            ? camera.y === 0
              ? camera.height
              : camera.y
            : CAPTION_Y[edit.position];
      } else if (edit.text) {
        words.push({
          text: edit.text,
          style: edit.style,
          position: edit.position,
          color: edit.color,
          highlight: edit.highlightColor,
          shown: easing(span, at, "fade", "fade"),
        });
      }
    } else if (edit.type === "end-card") {
      endCard = { assetId: edit.assetId, text: edit.text };
    }
  }
  return {
    camera,
    asset,
    ...gradeFilters(plan, clips, at),
    gap: gapAt(plan, clips, at, clip),
    overlays,
    marks,
    words,
    endCard,
    captionsY,
  };
}

/** The B-roll moments of an edit for the editor's gap tiles: each gap edit and skipped shot. */
export interface GapSlot {
  slotId: string;
  description: string;
  span: Span;
  /** A skipped shot's index; null for a B-roll gap of the original. */
  shotIndex: number | null;
}

export function gapSlots(plan: ShotPlan, clips: readonly Clip[]): GapSlot[] {
  const fromEdits = plan.edits
    .filter((edit): edit is EditOf<"gap"> => edit.type === "gap")
    .map((edit, index) => ({
      slotId: gapSlotId(index + 1),
      description: edit.description,
      span: spanOf(clips, edit),
      shotIndex: null,
    }));
  const skipped = clips
    .filter((clip) => clip.state === "missing")
    .map((clip) => ({
      slotId: shotSlotId(clip.index + 1),
      description: clip.shot.scene ? `${clip.shot.title}: ${clip.shot.scene}` : clip.shot.title,
      span: { start: clip.at, end: clip.at + clip.seconds },
      shotIndex: clip.index,
    }));
  return [...fromEdits, ...skipped].sort((a, b) => a.span.start - b.span.start);
}

/** Whether a slot id is a gap's or a skipped shot's (B-roll, which can be a Veo clip). */
export const isGapSlot = (slotId: string) => /^(gap|shot)-\d+$/.test(slotId);
