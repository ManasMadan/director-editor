/**
 * Painting the finished video's frames (lib/compose.ts) as lib/scene.ts lays them out:
 * the member's picture and the assets in their boxes, graded; a gap's B-roll or the
 * nearest take held; the marks, words and end card. Read back pixel by pixel.
 */
import type { Asset, Shot, ShotPlan } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composer, type Picture, type Visual } from "@/modules/director/lib/compose";
import type { Clip } from "@/modules/director/lib/edit";
import { loadedVideo } from "@/modules/director/lib/media";
import { recordVideo } from "../support";
import { canvasOf } from "./footage";

afterEach(() => {
  vi.restoreAllMocks();
});

type Edit = ShotPlan["edits"][number];
const WIDTH = 90;
const HEIGHT = 160;
const timed = { startSeconds: 0, endSeconds: 10 };

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

const asset = (id: string, kind: Asset["kind"]): Asset => ({
  id,
  kind,
  title: id,
  role: "r",
  description: "d",
  prompt: "p",
  sourceStartSeconds: 0,
  sourceEndSeconds: 10,
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

const planOf = (edits: Edit[], assets: Asset[] = [], shots = [shot(0, 10)]): ShotPlan => ({
  title: "t",
  format: "f",
  summary: "s",
  audio: "speech",
  durationSeconds: 10,
  shots,
  assets,
  edits,
});

/** Each shot played for its own length, end to end; those in `gaps` left as gaps. */
function clipsOf(shots: Shot[], gaps: number[] = []): Clip[] {
  let at = 0;
  return shots.map((each, index) => {
    const clip: Clip = {
      index,
      shot: each,
      take: null,
      state: gaps.includes(index) ? "gap" : "cut",
      at,
      seconds: each.durationSeconds,
      from: 0,
      to: each.durationSeconds,
    };
    at += each.durationSeconds;
    return clip;
  });
}

/** A picture all one colour, `width` by `height`. */
function solid(color: string, width = WIDTH, height = HEIGHT): Picture {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return { source: canvas, width, height };
}

async function image(color: string, width = 40, height = 40): Promise<Visual> {
  const { source } = solid(color, width, height);
  return { kind: "image", image: await createImageBitmap(source) };
}

/** The render's canvas, a painter for it, and its pixel at a point (fractions of the frame). */
function painter(
  plan: ShotPlan,
  assets: Map<string, Visual> = new Map(),
  hold: Picture | null = null,
  clips = clipsOf(plan.shots),
) {
  const { canvas, ctx } = canvasOf(WIDTH, HEIGHT);
  const paint = composer(ctx, plan, clips, assets, hold);
  const pixel = (x: number, y: number) => [
    ...ctx.getImageData(Math.floor(x * WIDTH), Math.floor(y * HEIGHT), 1, 1).data.slice(0, 3),
  ];
  return { paint, pixel, canvas };
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GROUND = [17, 17, 17];

/** Whether a pixel is near a colour (canvases smooth edges and grades round). */
const near = (pixel: number[], color: number[]) =>
  pixel.every((value, index) => Math.abs(value - (color[index] ?? 0)) <= 12);

describe("the member's picture and the assets", () => {
  it("fills the frame with the member's picture, graded as the edit list says", () => {
    const { paint, pixel } = painter(
      planOf([{ type: "grade", ...timed, grade: "black-and-white", target: "camera" }]),
    );
    expect(paint.paint(1, solid("#ff0000"))).toBe(0.64);
    const [r, g, b] = pixel(0.5, 0.5);
    // Grey: the red put through grayscale(1).
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("splits the frame with the chosen asset, and returns where the captions sit", async () => {
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
      captionStyle: null,
      color: null,
      highlightColor: null,
    };
    const { paint, pixel } = painter(
      planOf([split, captions], [asset("chart", "image")]),
      new Map([["chart", await image("#0000ff")]]),
    );
    expect(paint.paint(1, solid("#ff0000"))).toBe(0.5);
    expect(near(pixel(0.5, 0.2), RED)).toBe(true);
    expect(near(pixel(0.5, 0.8), BLUE)).toBe(true);
  });

  it("fits a card with words whole on a dark ground, and the member's picture for an asset not there", async () => {
    const full: Edit = {
      type: "layout",
      ...timed,
      layout: "full",
      assetId: "card",
      cameraOn: null,
      cameraShare: null,
      box: null,
      inset: null,
    };
    const card = painter(
      planOf([full], [asset("card", "text-card")]),
      new Map([["card", await image("#0000ff", 40, 40)]]),
    );
    card.paint.paint(1, solid("#ff0000"));
    // A square card in a 9:16 frame: the ground above and below it.
    expect(near(card.pixel(0.5, 0.05), GROUND)).toBe(true);
    expect(near(card.pixel(0.5, 0.5), BLUE)).toBe(true);

    const missing = painter(planOf([full], [asset("card", "text-card")]));
    missing.paint.paint(1, solid("#ff0000"));
    expect(near(missing.pixel(0.5, 0.5), RED)).toBe(true);
    // No camera either (a skipped shot's frame): the ground.
    missing.paint.paint(1, null);
    expect(near(missing.pixel(0.5, 0.5), GROUND)).toBe(true);
  });
});

describe("a gap's B-roll", () => {
  const gap: Edit = { type: "gap", startSeconds: 2, endSeconds: 4, description: "A hall" };

  it("shows a chosen still over the member's picture, pushing in, and plain picture outside it", async () => {
    const { paint, pixel } = painter(
      planOf([gap, { type: "grade", ...timed, grade: "warm", target: "assets" }]),
      new Map([["gap-1", await image("#0000ff")]]),
    );
    paint.paint(1, solid("#ff0000"));
    expect(near(pixel(0.5, 0.5), RED)).toBe(true);
    paint.paint(3, solid("#ff0000"));
    // Blue, warmed.
    const [r, , b] = pixel(0.5, 0.5);
    expect(b).toBeGreaterThan(r ?? 0);
  });

  it("plays one clip at a time from where its gap has got to, and stops them", async () => {
    const footage = await recordVideo(1);
    const first = await loadedVideo(URL.createObjectURL(footage));
    const second = await loadedVideo(URL.createObjectURL(footage));
    const plan = planOf([
      { type: "gap", startSeconds: 2, endSeconds: 4, description: "A hall" },
      { type: "gap", startSeconds: 5, endSeconds: 7, description: "A street" },
    ]);
    const { paint } = painter(
      plan,
      new Map<string, Visual>([
        ["gap-1", { kind: "video", video: first }],
        ["gap-2", { kind: "video", video: second }],
      ]),
    );
    paint.paint(2.5, solid("#ff0000"));
    await expect.poll(() => first.paused).toBe(false);
    // Already playing: left to play on.
    paint.paint(2.6, solid("#ff0000"));
    paint.paint(5.5, solid("#ff0000"));
    expect(first.paused).toBe(true);
    await expect.poll(() => second.paused).toBe(false);
    paint.stop();
    expect(second.paused).toBe(true);
  });

  it("keeps a clip that won't play still, and holds the member's last frame while it has no picture", async () => {
    // A video element with nothing in it: no size, no duration, and play() refused.
    const empty = document.createElement("video");
    const pause = vi.spyOn(empty, "pause");
    const { paint, pixel } = painter(
      planOf([gap]),
      new Map<string, Visual>([["gap-1", { kind: "video", video: empty }]]),
    );
    paint.paint(1, solid("#ff0000"));
    paint.paint(3, solid("#00ff00"));
    expect(empty.currentTime).toBe(0);
    await expect.poll(() => pause.mock.calls.length).toBeGreaterThan(0);
    // No picture of its own yet: the member's frame from before the gap.
    expect(near(pixel(0.5, 0.5), RED)).toBe(true);
  });

  it("holds the nearest take's picture through a skipped shot with nothing chosen", () => {
    const shots = [shot(0, 10), shot(10, 20)];
    const plan = planOf([], [], shots);
    const clips = clipsOf(shots, [1]);
    // Straight into the skipped shot: the take's frame the render was given.
    const given = painter(plan, new Map(), solid("#0000ff"), clips);
    given.paint.paint(15, null);
    expect(near(given.pixel(0.5, 0.5), BLUE)).toBe(true);
    // After the member's own frames: the last of them.
    const after = painter(plan, new Map(), solid("#0000ff"), clips);
    after.paint.paint(5, solid("#ff0000"));
    after.paint.paint(15, null);
    expect(near(after.pixel(0.5, 0.5), RED)).toBe(true);
    // Nothing to hold at all: the ground.
    const nothing = painter(plan, new Map(), null, clips);
    nothing.paint.paint(15, null);
    expect(near(nothing.pixel(0.5, 0.5), GROUND)).toBe(true);
  });

  it("paints on where the browser has no canvas to keep the last frame in", () => {
    const shots = [shot(0, 10), shot(10, 20)];
    const plan = planOf([], [], shots);
    const { canvas, ctx } = canvasOf(WIDTH, HEIGHT);
    const [red, blue] = [solid("#ff0000"), solid("#0000ff")];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const paint = composer(ctx, plan, clipsOf(shots, [1]), new Map(), blue);
    paint.paint(5, red);
    paint.paint(15, null);
    vi.restoreAllMocks();
    const [r, g, b] = [...ctx.getImageData(45, 80, 1, 1).data.slice(0, 3)];
    // Not the member's last frame (there was nowhere to keep it): the take given.
    expect(near([r ?? 0, g ?? 0, b ?? 0], BLUE)).toBe(true);
    expect(canvas.width).toBe(WIDTH);
  });
});

describe("what's drawn over the frame", () => {
  const box = { x: 0.1, y: 0.1, width: 0.5, height: 0.3 };
  const mark = (
    kind: NonNullable<Extract<Edit, { type: "overlay" }>["mark"]>,
    color: string | null,
  ): Edit => ({
    type: "overlay",
    ...timed,
    assetId: null,
    mark: kind,
    color,
    box,
    entry: "cut",
    exit: "cut",
  });

  it("draws each kind of mark, in its colour or the default", () => {
    const kinds = ["circle", "underline", "highlight", "arrow", "tick", "cross", "box"] as const;
    for (const [index, kind] of kinds.entries()) {
      const { paint, canvas } = painter(planOf([mark(kind, index % 2 ? "#00ff00" : null)]));
      paint.paint(1, solid("#000000"));
      const pixels = canvas.getContext("2d")?.getImageData(0, 0, WIDTH, HEIGHT).data ?? [];
      // Something other than the black picture was drawn.
      expect(
        Array.from(pixels).some((value, at) => at % 4 !== 3 && value > 40),
        kind,
      ).toBe(true);
    }
  });

  it("lays an asset over the frame, and leaves out one that isn't there", async () => {
    const overlay = (assetId: string): Edit => ({
      type: "overlay",
      ...timed,
      assetId,
      mark: null,
      color: null,
      box,
      entry: "cut",
      exit: "cut",
    });
    const { paint, pixel } = painter(
      planOf([overlay("logo"), overlay("gone")], [asset("logo", "image")]),
      new Map([["logo", await image("#0000ff")]]),
    );
    paint.paint(1, solid("#ff0000"));
    expect(near(pixel(0.3, 0.2), BLUE)).toBe(true);
    expect(near(pixel(0.8, 0.8), RED)).toBe(true);
  });

  it("writes titles, lower thirds and labels, cutting a long line short", () => {
    const words = (
      style: "title" | "lower-third" | "label",
      text: string,
      overrides: Partial<Extract<Edit, { type: "text" }>> = {},
    ): Edit => ({
      type: "text",
      ...timed,
      style,
      text,
      position: "middle",
      captionStyle: null,
      color: null,
      highlightColor: null,
      ...overrides,
    });
    const filled = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    const { paint } = painter(
      planOf([
        words("title", "Day one"),
        words("lower-third", "Priya, founder"),
        words("label", "x".repeat(70), { color: "#ffff00", highlightColor: "#ff00ff" }),
        words("label", "On a dark bar"),
      ]),
    );
    paint.paint(5, solid("#000000"));
    expect(filled.mock.calls.map(([text]) => text)).toEqual([
      "Day one",
      "Priya, founder",
      `${"x".repeat(59)}…`,
      "On a dark bar",
    ]);
  });
});

describe("the end card", () => {
  const card = (assetId: string | null, text: string | null): Edit => ({
    type: "end-card",
    ...timed,
    assetId,
    text,
  });

  it("shows its picture whole, else its words, else the ground", async () => {
    const picture = painter(
      planOf([card("end", "Apply now")], [asset("end", "end-card")]),
      new Map([["end", await image("#0000ff", 40, 40)]]),
    );
    picture.paint.paint(1, solid("#ff0000"));
    expect(near(picture.pixel(0.5, 0.5), BLUE)).toBe(true);
    expect(near(picture.pixel(0.5, 0.05), GROUND)).toBe(true);

    const filled = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    // Its picture is a clip with nothing in it yet: the words instead.
    const words = painter(
      planOf([card("end", "Apply now")], [asset("end", "end-card")]),
      new Map<string, Visual>([["end", { kind: "video", video: document.createElement("video") }]]),
    );
    words.paint.paint(1, solid("#ff0000"));
    expect(filled.mock.calls.map(([text]) => text)).toEqual(["Apply now"]);

    const ground = painter(planOf([card(null, null)]));
    ground.paint.paint(1, solid("#ff0000"));
    expect(near(ground.pixel(0.5, 0.5), GROUND)).toBe(true);
  });
});
