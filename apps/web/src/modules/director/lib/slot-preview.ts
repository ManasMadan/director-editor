/**
 * Where an asset sits in the member's video, from the plan's edit list: the frame it
 * shares with the camera (full, a split, picture-in-picture, or an overlay's box), how
 * it fills its box, and the grade the template gives it. The asset picker's "Preview in
 * your video" draws this, so a candidate is seen placed, fitted and graded as the edit
 * list says before it's used. Boxes are fractions of the 9:16 frame from its top-left.
 */
import type { FrameBox, ShotPlan } from "@repo/contracts/api";

type Asset = ShotPlan["assets"][number];
type Edit = ShotPlan["edits"][number];
type Grade = Extract<Edit, { type: "grade" }>["grade"];

export interface SlotPlacement {
  /** Where the asset is drawn. */
  asset: FrameBox;
  /** Where the member's camera picture is, when it shares the frame. */
  camera: FrameBox | null;
  /**
   * `cover` crops to fill the box; `contain` fits it whole, on the template's
   * background, for a graphic with words that mustn't be cut.
   */
  fit: "cover" | "contain";
  /** A CSS filter for the template's grade on the asset (none: no grade). */
  filter: string | null;
  /** Where captions sit, when the template has them. */
  captions: "top" | "middle" | "bottom" | "between-halves" | null;
}

const FULL: FrameBox = { x: 0, y: 0, width: 1, height: 1 };

// The grades as canvas and CSS filters: black and white is grayscale(1), as the editor
// renders it; the rest are close looks.
export const FILTERS: Record<Grade, string> = {
  "black-and-white": "grayscale(1)",
  warm: "sepia(0.25) saturate(1.2)",
  cool: "saturate(0.9) hue-rotate(-12deg)",
  "high-contrast": "contrast(1.4)",
  vintage: "sepia(0.45) contrast(1.05)",
  vivid: "saturate(1.5)",
};

// Graphics carrying words are fitted whole rather than cropped.
const CONTAINED = new Set<Asset["kind"]>(["text-card", "end-card"]);

function overlaps(edit: Edit, asset: Asset) {
  return edit.startSeconds < asset.sourceEndSeconds && edit.endSeconds > asset.sourceStartSeconds;
}

function splitBoxes(edit: Extract<Edit, { type: "layout" }>) {
  const share = edit.cameraShare ?? 0.5;
  const top = { x: 0, y: 0, width: 1, height: share };
  const bottom = { x: 0, y: share, width: 1, height: 1 - share };
  return edit.cameraOn === "bottom"
    ? { camera: { ...bottom, y: 1 - share, height: share }, asset: { ...top, height: 1 - share } }
    : { camera: top, asset: bottom };
}

function layoutBoxes(edit: Extract<Edit, { type: "layout" }>) {
  if (edit.layout === "split") {
    return splitBoxes(edit);
  }
  if (edit.layout === "picture-in-picture" && edit.box) {
    return edit.inset === "camera"
      ? { camera: edit.box, asset: FULL }
      : { camera: FULL, asset: edit.box };
  }
  return { camera: null, asset: FULL };
}

function boxesOf(plan: ShotPlan, asset: Asset) {
  const layout = plan.edits.find(
    (edit): edit is Extract<Edit, { type: "layout" }> =>
      edit.type === "layout" && edit.assetId === asset.id,
  );
  if (layout) {
    return layoutBoxes(layout);
  }
  const overlay = plan.edits.find((edit) => edit.type === "overlay" && edit.assetId === asset.id);
  if (overlay?.type === "overlay") {
    return { camera: FULL, asset: overlay.box };
  }
  return { camera: null, asset: FULL };
}

export function slotPlacement(plan: ShotPlan, asset: Asset): SlotPlacement {
  const grade = plan.edits.find(
    (edit): edit is Extract<Edit, { type: "grade" }> =>
      edit.type === "grade" && edit.target !== "camera" && overlaps(edit, asset),
  );
  const captions = plan.edits.find(
    (edit): edit is Extract<Edit, { type: "text" }> =>
      edit.type === "text" && edit.style === "captions" && overlaps(edit, asset),
  );
  const look = asset.reference.blackAndWhite ? FILTERS["black-and-white"] : null;
  return {
    ...boxesOf(plan, asset),
    fit: CONTAINED.has(asset.kind) ? "contain" : "cover",
    filter: grade ? FILTERS[grade.grade] : look,
    captions: captions ? captions.position : null,
  };
}

/** The frame's shape for a stock search from the slot's box (9:16 frame, so 9 by 16). */
export function slotOrientation(box: FrameBox): "portrait" | "landscape" | "square" {
  const ratio = (box.width * 9) / (box.height * 16);
  if (ratio > 1.1) {
    return "landscape";
  }
  return ratio < 0.9 ? "portrait" : "square";
}
