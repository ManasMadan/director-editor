import type { ShotPlan } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { needsOf } from "./needs";
import { slotOrientation, slotPlacement } from "./slot-preview";

type Asset = ShotPlan["assets"][number];
type Shot = ShotPlan["shots"][number];
type Edit = ShotPlan["edits"][number];

// The shapes of the spec's asset Shorts: OvRozQobeuI's chart under the speaker.
function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "chart",
    kind: "image",
    title: "The chart",
    role: "Under the speaker",
    description: "A ranked chart of twelve archetypes.",
    prompt: 'A flat infographic titled "12 MALE ARCHETYPES".',
    sourceStartSeconds: 0,
    sourceEndSeconds: 28,
    defaultSource: "create",
    personalisable: true,
    ask: null,
    secondScreen: false,
    reference: {
      subject: "Twelve thinking archetypes",
      composition: "Title on top, twelve rows",
      style: "Flat vector",
      palette: "Colourful",
      blackAndWhite: false,
      aspectRatio: "9:8",
      text: ["12 MALE ARCHETYPES"],
      brands: [],
      mood: "Bold",
    },
    ...overrides,
  };
}

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    kind: "video",
    mode: "on-camera",
    title: "Talk",
    purpose: "Hook",
    sourceStartSeconds: 0,
    sourceEndSeconds: 28,
    durationSeconds: 28,
    camera: "front",
    scene: "At a desk",
    sceneLandmark: null,
    framing: { shotSize: "medium", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "" },
    phoneAngle: { pitch: 0, roll: 0, tolerance: 10, height: "eye" },
    pose: { description: "", keypoints: [] },
    steps: [],
    script: [],
    ...overrides,
  };
}

function plan(overrides: Partial<ShotPlan> = {}): ShotPlan {
  return {
    title: "12 archetypes",
    format: "Talking head",
    summary: "",
    audio: "speech",
    durationSeconds: 34,
    shots: [shot()],
    assets: [asset()],
    edits: [],
    ...overrides,
  };
}

const timed = { startSeconds: 0, endSeconds: 28 };
const FULL = { x: 0, y: 0, width: 1, height: 1 };
const BOX = { x: 0.6, y: 0.05, width: 0.35, height: 0.2 };

const SPLIT = {
  type: "layout",
  ...timed,
  layout: "split",
  assetId: "chart",
  cameraOn: "top",
  cameraShare: 0.5,
  box: null,
  inset: null,
} as const satisfies Edit;

const CAPTIONS = {
  type: "text",
  ...timed,
  style: "captions",
  text: null,
  position: "between-halves",
  captionStyle: "word-by-word",
  color: null,
  highlightColor: null,
} as const satisfies Edit;

const OVERLAY = {
  type: "overlay",
  ...timed,
  assetId: "chart",
  mark: null,
  color: null,
  box: BOX,
  entry: "fade",
  exit: "fade",
} as const satisfies Edit;

const text = (
  style: "title" | "lower-third" | "captions",
  captionStyle: "boxed" | "line" | null,
): Edit => ({ ...CAPTIONS, style, captionStyle });

describe("what you'll need", () => {
  it("reads a talking head with a chart under it, captions and an end card", () => {
    const needs = needsOf(
      plan({
        shots: [shot({ script: [{ startSeconds: 0, endSeconds: 28, text: "Twelve types." }] })],
        edits: [
          SPLIT,
          CAPTIONS,
          { type: "end-card", startSeconds: 28, endSeconds: 34, assetId: null, text: null },
          { type: "transition", ...timed, transition: "cut", anchor: null },
          OVERLAY,
        ],
      }),
    );
    expect(needs.presence).toBe("on-camera");
    // 28 seconds filmed, about four tries each: two minutes.
    expect(needs.minutes).toBe(2);
    expect(needs.makes.map((made) => made.id)).toEqual(["chart"]);
    expect(needs.editing).toEqual(["split", "wordCaptions", "endCard"]);
  });

  it("tells a voice-over from a mix and from nobody at all", () => {
    const voice = shot({ mode: "voice-over" });
    const still = shot({ mode: "asset", durationSeconds: 5 });
    expect(needsOf(plan({ shots: [voice] })).presence).toBe("voice-only");
    expect(needsOf(plan({ shots: [shot(), voice] })).presence).toBe("on-camera-and-voice");
    // Nothing filmed still takes a minute to set up.
    expect(needsOf(plan({ shots: [still] }))).toMatchObject({ presence: "nobody", minutes: 1 });
  });

  it("never says talking to the camera when no shot has a line", () => {
    // "No talking, just hands and the mug": filmed, nobody in it, nothing said.
    expect(needsOf(plan({ shots: [shot(), shot()] })).presence).toBe("nobody");
    // On camera, without a word.
    const posed = shot({
      pose: { description: "Smiling.", keypoints: [{ name: "nose", x: 0.5, y: 0.3 }] },
    });
    expect(needsOf(plan({ shots: [posed, shot()] })).presence).toBe("on-camera-silent");
    const said = shot({ script: [{ startSeconds: 0, endSeconds: 2, text: "Hi" }] });
    expect(needsOf(plan({ shots: [posed, said] })).presence).toBe("on-camera");
  });

  it("names each kind of editing once", () => {
    const needs = needsOf(
      plan({
        edits: [
          { ...SPLIT, layout: "picture-in-picture", box: FULL, inset: "camera" },
          { ...SPLIT, layout: "full" },
          text("captions", "boxed"),
          text("captions", null),
          text("captions", "line"),
          text("lower-third", null),
          text("title", null),
          { type: "grade", ...timed, grade: "black-and-white", target: "all" },
          { type: "grade", ...timed, grade: "warm", target: "all" },
          { type: "transition", ...timed, transition: "whip", anchor: null },
          { type: "speed", ...timed, fromRate: 1, toRate: 2, easing: "linear" },
          { type: "gap", ...timed, description: "Campus" },
        ],
      }),
    );
    expect(needs.editing).toEqual([
      "pictureInPicture",
      "boxedCaptions",
      "captions",
      "lowerThirds",
      "titles",
      "blackAndWhite",
      "grade",
      "transitions",
      "speed",
      "broll",
    ]);
  });
});

describe("where a picture sits in the member's video", () => {
  it("fills the bottom half of a split under the camera, with captions at the seam", () => {
    const placement = slotPlacement(plan({ edits: [SPLIT, CAPTIONS] }), asset());
    expect(placement).toEqual({
      camera: { x: 0, y: 0, width: 1, height: 0.5 },
      asset: { x: 0, y: 0.5, width: 1, height: 0.5 },
      fit: "cover",
      filter: null,
      captions: "between-halves",
    });
    expect(slotOrientation(placement.asset)).toBe("landscape");
  });

  it("puts the camera at the bottom when the template does, at its share", () => {
    const bottom = { ...SPLIT, cameraOn: "bottom", cameraShare: 0.4 } as const;
    expect(slotPlacement(plan({ edits: [bottom] }), asset())).toMatchObject({
      camera: { x: 0, y: 0.6, width: 1, height: 0.4 },
      asset: { x: 0, y: 0, width: 1, height: 0.6 },
    });
    const halves = { ...SPLIT, cameraShare: null };
    expect(slotPlacement(plan({ edits: [halves] }), asset()).asset.height).toBe(0.5);
  });

  it("grades it as the template does: black and white by its edit or its reference", () => {
    const grade = {
      type: "grade",
      ...timed,
      grade: "black-and-white",
      target: "assets",
    } as const satisfies Edit;
    expect(slotPlacement(plan({ edits: [grade] }), asset()).filter).toBe("grayscale(1)");
    const camera = { ...grade, grade: "vivid", target: "camera" } as const;
    expect(slotPlacement(plan({ edits: [camera] }), asset()).filter).toBeNull();
    const later = { ...grade, startSeconds: 30, endSeconds: 34 };
    expect(slotPlacement(plan({ edits: [later] }), asset()).filter).toBeNull();
    const grey = asset({ reference: { ...asset().reference, blackAndWhite: true } });
    expect(slotPlacement(plan(), grey).filter).toBe("grayscale(1)");
  });

  it("keeps a card's words whole, and places insets and overlays in their box", () => {
    const card = asset({ kind: "text-card" });
    expect(slotPlacement(plan(), card)).toMatchObject({
      fit: "contain",
      camera: null,
      asset: FULL,
    });
    const inset = { ...SPLIT, layout: "picture-in-picture", box: BOX, inset: "asset" } as const;
    expect(slotPlacement(plan({ edits: [inset] }), asset())).toMatchObject({
      camera: FULL,
      asset: BOX,
    });
    const cameraInset = { ...inset, inset: "camera" } as const;
    expect(slotPlacement(plan({ edits: [cameraInset] }), asset())).toMatchObject({
      camera: BOX,
      asset: FULL,
    });
    const unboxed = { ...inset, box: null };
    expect(slotPlacement(plan({ edits: [unboxed] }), asset()).asset).toEqual(FULL);
    expect(slotPlacement(plan({ edits: [OVERLAY] }), asset())).toMatchObject({
      camera: FULL,
      asset: BOX,
    });
  });

  it("searches stock in the slot's shape", () => {
    expect(slotOrientation(FULL)).toBe("portrait");
    expect(slotOrientation({ x: 0, y: 0, width: 1, height: 9 / 16 })).toBe("square");
  });
});
