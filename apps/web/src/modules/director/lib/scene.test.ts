import type { Asset, Shot, ShotPlan } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import type { Clip } from "./edit";
import { editTime, gapSlots, isGapSlot, sceneAt, spanOf } from "./scene";

type Edit = ShotPlan["edits"][number];

const shot = (start: number, end: number, mode: Shot["mode"] = "on-camera"): Shot => ({
  kind: "video",
  mode,
  title: `Shot at ${start}`,
  purpose: "p",
  sourceStartSeconds: start,
  sourceEndSeconds: end,
  durationSeconds: end - start,
  camera: "front",
  scene: "By a window",
  sceneLandmark: null,
  framing: { shotSize: "medium", subject: { x: 0, y: 0, width: 1, height: 1 }, note: "n" },
  phoneAngle: { pitch: 0, roll: 0, tolerance: 5, height: "eye" },
  pose: { description: "d", keypoints: [] },
  steps: [],
  script: [],
});

const asset = (id: string, kind: Asset["kind"], start: number, end: number): Asset => ({
  id,
  kind,
  title: id,
  role: "r",
  description: "d",
  prompt: "p",
  sourceStartSeconds: start,
  sourceEndSeconds: end,
  defaultSource: "create",
  personalisable: false,
  ask: null,
  secondScreen: false,
  reference: {
    subject: "s",
    composition: "c",
    style: "s",
    palette: "p",
    blackAndWhite: false,
    aspectRatio: "9:16",
    text: [],
    brands: [],
    mood: "m",
  },
});

const plan = (shots: Shot[], assets: Asset[], edits: Edit[]): ShotPlan => ({
  title: "t",
  format: "f",
  summary: "s",
  audio: "speech",
  durationSeconds: 20,
  shots,
  assets,
  edits,
});

/**
 * Clips of the member's edit: each shot played for `seconds`, end to end; the shots in
 * `gaps` left as gaps by their version, those in `unfilmed` not filmed yet.
 */
function clipsOf(shots: Shot[], seconds: number[], gaps: number[] = [], unfilmed: number[] = []) {
  let at = 0;
  return shots.map((each, index) => {
    const length = seconds[index] ?? each.durationSeconds;
    let state: Clip["state"] = gaps.includes(index) ? "gap" : "cut";
    if (unfilmed.includes(index)) {
      state = "missing";
    }
    const clip: Clip = {
      index,
      shot: each,
      take: null,
      state,
      at,
      seconds: length,
      from: 0,
      to: length,
    };
    at += length;
    return clip;
  });
}

const timed = { startSeconds: 0, endSeconds: 10 };

describe("moving the original's times onto the member's edit", () => {
  const shots = [shot(0, 10), shot(10, 20)];
  // The member took 5 s over the first shot and 20 s over the second.
  const clips = clipsOf(shots, [5, 20]);

  it("scales a moment by its shot's length in the edit", () => {
    expect(editTime(clips, 0)).toBe(0);
    expect(editTime(clips, 5)).toBe(2.5);
    expect(editTime(clips, 15)).toBe(15);
    expect(editTime(clips, 99)).toBe(25);
    expect(editTime([], 3)).toBe(0);
  });

  it("puts a moment between two of the original's shots at the next one's start", () => {
    const gapped = clipsOf([shot(0, 4), shot(6, 10)], [4, 4]);
    expect(editTime(gapped, 5)).toBe(4);
    expect(spanOf(gapped, { startSeconds: 5, endSeconds: 8 })).toEqual({ start: 4, end: 6 });
  });
});

describe("what the saved video shows", () => {
  const split: Edit = {
    type: "layout",
    ...timed,
    layout: "split",
    assetId: "chart",
    cameraOn: "top",
    cameraShare: 0.5,
    box: null,
    inset: null,
  };
  const captions: Edit = {
    type: "text",
    ...timed,
    style: "captions",
    text: null,
    position: "between-halves",
    captionStyle: "word-by-word",
    color: null,
    highlightColor: null,
  };

  it("splits the frame: the member on top, the chosen chart below, captions on the seam", () => {
    const p = plan([shot(0, 10)], [asset("chart", "image", 0, 10)], [split, captions]);
    const scene = sceneAt(p, clipsOf(p.shots, [10]), 4);
    expect(scene.camera).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(scene.asset).toMatchObject({ assetId: "chart", box: { y: 0.5, height: 0.5 } });
    expect(scene.captionsY).toBe(0.5);
  });

  it("puts the camera at the bottom when the original did, and the asset in a box for picture-in-picture", () => {
    const bottom = sceneAt(
      plan([shot(0, 10)], [asset("chart", "image", 0, 10)], [{ ...split, cameraOn: "bottom" }]),
      clipsOf([shot(0, 10)], [10]),
      1,
    );
    expect(bottom.camera).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    const box = { x: 0.6, y: 0.1, width: 0.3, height: 0.2 };
    const pip = sceneAt(
      plan(
        [shot(0, 10)],
        [asset("logo", "image", 0, 10)],
        [{ ...split, layout: "picture-in-picture", box, inset: "asset" }],
      ),
      clipsOf([shot(0, 10)], [10]),
      1,
    );
    expect(pip.camera).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(pip.asset?.box).toEqual(box);
  });

  it("shows only the image under a voice-over, never the camera picture", () => {
    const p = plan([shot(0, 10, "voice-over")], [asset("board", "image", 0, 10)], []);
    const scene = sceneAt(p, clipsOf(p.shots, [10]), 2);
    expect(scene.camera).toBeNull();
    expect(scene.asset).toMatchObject({ assetId: "board", box: { width: 1, height: 1 } });
  });

  it("grades the camera and the assets as the edit list says", () => {
    const p = plan(
      [shot(0, 10)],
      [],
      [
        { type: "grade", ...timed, grade: "black-and-white", target: "all" },
        { type: "grade", ...timed, grade: "warm", target: "camera" },
      ],
    );
    const scene = sceneAt(p, clipsOf(p.shots, [10]), 1);
    expect(scene.cameraFilter).toBe("grayscale(1) sepia(0.25) saturate(1.2)");
    expect(scene.assetFilter).toBe("grayscale(1)");
  });

  it("draws lower thirds, marks and asset overlays, fading them in", () => {
    const p = plan(
      [shot(0, 10)],
      [asset("logo", "image", 0, 10)],
      [
        {
          type: "text",
          ...timed,
          style: "lower-third",
          text: "25L in revenue",
          position: "bottom",
          captionStyle: null,
          color: null,
          highlightColor: "#6d28d9",
        },
        {
          type: "overlay",
          ...timed,
          assetId: null,
          mark: "circle",
          color: "#ff0000",
          box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          entry: "draw",
          exit: "cut",
        },
        {
          type: "overlay",
          ...timed,
          assetId: "logo",
          mark: null,
          color: null,
          box: { x: 0.8, y: 0, width: 0.2, height: 0.1 },
          entry: "fade",
          exit: "fade",
        },
      ],
    );
    const clips = clipsOf(p.shots, [10]);
    const early = sceneAt(p, clips, 0.1);
    expect(early.words[0]).toMatchObject({ text: "25L in revenue", style: "lower-third" });
    expect(early.words[0]?.shown).toBeLessThan(1);
    expect(early.marks[0]?.drawn).toBeLessThan(1);
    expect(early.overlays[0]?.shown).toBeLessThan(1);
    const later = sceneAt(p, clips, 5);
    expect(later.marks[0]?.drawn).toBe(1);
    expect(later.overlays[0]).toMatchObject({ assetId: "logo", shown: 1 });
  });

  it("closes on the end card", () => {
    const p = plan(
      [shot(0, 10)],
      [],
      [{ type: "end-card", startSeconds: 8, endSeconds: 10, assetId: null, text: "Apply now" }],
    );
    const clips = clipsOf(p.shots, [10]);
    expect(sceneAt(p, clips, 5).endCard).toBeNull();
    expect(sceneAt(p, clips, 9).endCard).toEqual({ assetId: null, text: "Apply now" });
  });
});

describe("the frame's layout, edge by edge", () => {
  const layout = (overrides: Partial<Extract<Edit, { type: "layout" }>>): Edit => ({
    type: "layout",
    ...timed,
    layout: "split",
    assetId: "chart",
    cameraOn: null,
    cameraShare: null,
    box: null,
    inset: null,
    ...overrides,
  });
  const one = (
    edits: Edit[],
    assets = [asset("chart", "text-card", 0, 10)],
    mode?: Shot["mode"],
  ) => {
    const p = plan([shot(0, 10, mode)], assets, edits);
    return sceneAt(p, clipsOf(p.shots, [10]), 1);
  };

  it("splits in half when the plan doesn't say how, and fits words whole", () => {
    const scene = one([layout({})]);
    expect(scene.camera).toEqual({ x: 0, y: 0, width: 1, height: 0.5 });
    expect(scene.asset).toMatchObject({ box: { y: 0.5, height: 0.5 }, fit: "contain" });
  });

  it("gives the asset the frame in a full layout that names one, else the camera", () => {
    expect(one([layout({ layout: "full" })])).toMatchObject({
      camera: null,
      asset: { assetId: "chart", box: { x: 0, y: 0, width: 1, height: 1 } },
    });
    expect(one([layout({ layout: "full", assetId: null })])).toMatchObject({
      camera: { width: 1, height: 1 },
      asset: null,
    });
    // Picture-in-picture with no box to put it in: the full frame.
    expect(one([layout({ layout: "picture-in-picture" })]).camera).toBeNull();
  });

  it("insets the member's picture in the asset for picture-in-picture of the camera", () => {
    const box = { x: 0.05, y: 0.05, width: 0.3, height: 0.2 };
    expect(one([layout({ layout: "picture-in-picture", box, inset: "camera" })])).toMatchObject({
      camera: box,
      asset: { box: { width: 1, height: 1 } },
    });
  });

  it("crops an asset the plan doesn't list, and grades the assets alone when it says so", () => {
    const scene = one(
      [
        layout({ assetId: "unlisted" }),
        { type: "grade", ...timed, grade: "vivid", target: "assets" },
      ],
      [],
    );
    expect(scene.asset?.fit).toBe("cover");
    expect(scene.cameraFilter).toBeNull();
    expect(scene.assetFilter).toBe("saturate(1.5)");
  });

  it("shows a voice-over's layout asset full frame, and the camera when it has no asset", () => {
    expect(one([layout({})], undefined, "voice-over")).toMatchObject({
      camera: null,
      asset: { assetId: "chart", box: { width: 1, height: 1 } },
    });
    // Footage of the original (B-roll) isn't the shot's picture: the camera stays.
    expect(one([], [asset("street", "broll", 0, 10)], "voice-over").camera).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("puts captions at a split's seam with the camera below, and in their place otherwise", () => {
    const captions = (position: "between-halves" | "top"): Edit => ({
      type: "text",
      ...timed,
      style: "captions",
      text: null,
      position,
      captionStyle: null,
      color: null,
      highlightColor: null,
    });
    expect(
      one([layout({ cameraOn: "bottom", cameraShare: 0.4 }), captions("between-halves")]).captionsY,
    ).toBe(0.6);
    expect(one([captions("between-halves")]).captionsY).toBe(0.5);
    expect(one([captions("top")]).captionsY).toBe(0.18);
  });

  it("draws a mark at once that isn't drawn on, cuts words in and out, and skips an empty overlay", () => {
    const scene = one([
      {
        type: "overlay",
        ...timed,
        assetId: null,
        mark: "tick",
        color: null,
        box: { x: 0, y: 0, width: 0.1, height: 0.1 },
        entry: "cut",
        exit: "cut",
      },
      {
        type: "overlay",
        ...timed,
        assetId: null,
        mark: null,
        color: null,
        box: { x: 0, y: 0, width: 0.1, height: 0.1 },
        entry: "fade",
        exit: "fade",
      },
      {
        type: "text",
        ...timed,
        style: "title",
        text: null,
        position: "top",
        captionStyle: null,
        color: null,
        highlightColor: null,
      },
    ]);
    expect(scene.marks).toEqual([
      { mark: "tick", box: { x: 0, y: 0, width: 0.1, height: 0.1 }, color: null, drawn: 1 },
    ]);
    expect(scene.overlays).toEqual([]);
    expect(scene.words).toEqual([]);
  });

  it("holds the last shot's frame past the edit's end", () => {
    const p = plan([shot(0, 10)], [], []);
    expect(sceneAt(p, clipsOf(p.shots, [10]), 12).camera).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("names a skipped shot with no place by its title alone", () => {
    const placeless = { ...shot(0, 10), scene: "" };
    const p = plan([placeless], [], []);
    expect(gapSlots(p, clipsOf(p.shots, [10], [0]))[0]?.description).toBe("Shot at 0");
  });
});

describe("gaps", () => {
  const p = plan(
    [shot(0, 10), shot(10, 20)],
    [],
    [{ type: "gap", startSeconds: 4, endSeconds: 6, description: "A bootcamp hall" }],
  );

  it("cuts to a gap's B-roll at the original's timing, and fills a skipped shot whole", () => {
    const clips = clipsOf(p.shots, [10, 10], [1]);
    expect(sceneAt(p, clips, 2).gap).toBeNull();
    expect(sceneAt(p, clips, 5).gap).toEqual({ slotId: "gap-1", seconds: 1, length: 2 });
    expect(sceneAt(p, clips, 13).gap).toEqual({ slotId: "shot-2", seconds: 3, length: 10 });
  });

  it("fills a shot saved without being filmed, as it does a gap", () => {
    const clips = clipsOf(p.shots, [10, 10], [], [1]);
    expect(sceneAt(p, clips, 13).gap).toEqual({ slotId: "shot-2", seconds: 3, length: 10 });
    expect(gapSlots(p, clips).map((slot) => slot.slotId)).toEqual(["gap-1", "shot-2"]);
    // A filmed shot is no moment to fill.
    expect(gapSlots(p, clipsOf(p.shots, [10, 10])).map((slot) => slot.slotId)).toEqual(["gap-1"]);
  });

  it("lists every moment to fill in the edit's order", () => {
    const clips = clipsOf(p.shots, [10, 10], [1]);
    expect(gapSlots(p, clips)).toEqual([
      {
        slotId: "gap-1",
        description: "A bootcamp hall",
        span: { start: 4, end: 6 },
        shotIndex: null,
      },
      {
        slotId: "shot-2",
        description: "Shot at 10: By a window",
        span: { start: 10, end: 20 },
        shotIndex: 1,
      },
    ]);
    expect(isGapSlot("gap-1")).toBe(true);
    expect(isGapSlot("shot-12")).toBe(true);
    expect(isGapSlot("chart")).toBe(false);
  });
});
