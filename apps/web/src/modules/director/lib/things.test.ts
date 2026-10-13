import { describe, expect, it } from "vitest";
import {
  type Detection,
  grounded,
  HOLD_SECONDS,
  held,
  highlights,
  MOST_HIGHLIGHTS,
  type Seen,
  seenIn,
  thingFor,
} from "./things";

const detection = (categoryName: string, box: Partial<Detection> = {}): Detection => ({
  categoryName,
  score: 0.8,
  originX: 100,
  originY: 100,
  width: 200,
  height: 300,
  ...box,
});

const seen = (thing: Seen["thing"], role: Seen["role"], score = 0.8): Seen => ({
  thing,
  role,
  score,
  box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
});

describe("things in the frame", () => {
  it("keeps the things worth pointing out, in the viewfinder's space", () => {
    // A portrait 1080×1920 camera: the viewfinder is the whole frame.
    const [plant, ...rest] = seenIn(
      [detection("potted plant", { originX: 108, originY: 192, width: 216, height: 384 })],
      1080,
      1920,
    );
    expect(rest).toEqual([]);
    expect(plant?.thing).toBe("plant");
    expect(plant?.role).toBe("backdrop");
    expect(plant?.box.x).toBeCloseTo(0.1);
    expect(plant?.box.y).toBeCloseTo(0.1);
    expect(plant?.box.width).toBeCloseTo(0.2);
  });

  it("leaves out what Director has nothing to say about and what's outside the view", () => {
    expect(seenIn([detection("fork"), detection("person")], 1080, 1920)).toEqual([]);
    // A 16:9 laptop camera shows only its middle: a cup at its far left is out of view.
    expect(seenIn([detection("cup", { originX: 0, width: 100 })], 1920, 1080)).toEqual([]);
    const [clipped] = seenIn([detection("cup", { originX: 600, width: 400 })], 1920, 1080);
    expect(clipped?.box.x).toBe(0);
  });

  it("puts the shot's landmark first, then co-stars, props, backdrops and screens", () => {
    const ranked = highlights(
      [
        seen("screen", "glare"),
        seen("chair", "backdrop"),
        seen("cup", "prop"),
        seen("dog", "pet"),
        seen("plant", "backdrop", 0.5),
      ],
      "Stand near a tree",
    ).map((item) => item.thing);
    expect(ranked).toEqual(["plant", "dog", "cup"]);
    expect(ranked).toHaveLength(MOST_HIGHLIGHTS);
  });

  it("highlights one of each kind, the surest", () => {
    const [cup, ...rest] = highlights([seen("cup", "prop", 0.5), seen("cup", "prop", 0.9)], null);
    expect(rest).toEqual([]);
    expect(cup?.score).toBe(0.9);
  });

  it("finds the detector's thing for the plan's landmark, in its words or the plan's", () => {
    expect(thingFor("Tree")).toBe("plant");
    expect(thingFor("the old sofa")).toBe("couch");
    expect(thingFor("a chair by the window")).toBe("chair");
    expect(thingFor("mirror")).toBeNull();
    expect(thingFor(null)).toBeNull();
  });

  it("keeps a thing highlighted for a moment after the detector last saw it", () => {
    const cup = seen("cup", "prop");
    const first = held([], [cup], 10);
    expect(held(first, [], 10 + HOLD_SECONDS / 2).map((item) => item.thing)).toEqual(["cup"]);
    expect(held(first, [], 10 + HOLD_SECONDS * 2)).toEqual([]);
    const moved = { ...cup, box: { ...cup.box, x: 0.5 } };
    expect(held(first, [moved], 10.1)[0]?.box.x).toBe(0.5);
  });

  it("puts the landmark where the phone sees it, over Gemini's older box", () => {
    const plant = seen("plant", "backdrop");
    const check = {
      inPlace: false,
      instruction: "Walk left to the tree",
      direction: "left",
      distanceMeters: 3,
      landmark: { label: "tree", box: { x: 0.9, y: 0.9, width: 0.05, height: 0.05 } },
      lighting: "good",
    } as const;
    expect(grounded(check, [plant], "tree")?.landmark).toEqual({ label: "tree", box: plant.box });
    expect(grounded(check, [plant], "tree")?.instruction).toBe("Walk left to the tree");
    expect(grounded(null, [plant], "tree")).toMatchObject({ inPlace: false, direction: "none" });
    expect(grounded(check, [], "tree")).toBe(check);
    expect(grounded(null, [plant], "mirror")).toBeNull();
  });
});
