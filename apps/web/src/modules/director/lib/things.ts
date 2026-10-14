/**
 * The things in the frame Director points out, from the on-device object detector
 * (lib/object-detector.ts, the COCO classes): which ones matter for a short, what part
 * they play (a prop to use, a backdrop, a co-star, a screen that glares), and which few to
 * highlight. Everything else it can see (forks, toilets, traffic lights) stays unmarked:
 * a highlight is a suggestion, so only things worth suggesting get one.
 */
import type { FrameBox, SceneCheck } from "@repo/contracts/api";
import { viewCrop } from "./view";

/** Each class worth pointing out, by the detector's own name, and its key in i18n. */
const THINGS = {
  "potted plant": "plant",
  chair: "chair",
  couch: "couch",
  bed: "bed",
  bench: "bench",
  "dining table": "table",
  tv: "screen",
  laptop: "screen",
  book: "book",
  cup: "cup",
  "wine glass": "cup",
  bottle: "bottle",
  vase: "vase",
  clock: "clock",
  handbag: "bag",
  backpack: "bag",
  suitcase: "bag",
  umbrella: "umbrella",
  "teddy bear": "teddy",
  "cell phone": "phone",
  "sports ball": "ball",
  skateboard: "skateboard",
  bicycle: "bike",
  car: "car",
  dog: "dog",
  cat: "cat",
  bird: "bird",
} as const;

export type Thing = (typeof THINGS)[keyof typeof THINGS];
type Role = "prop" | "backdrop" | "pet" | "glare";

const ROLES: Record<Thing, Role> = {
  plant: "backdrop",
  chair: "backdrop",
  couch: "backdrop",
  bed: "backdrop",
  bench: "backdrop",
  table: "backdrop",
  bike: "backdrop",
  car: "backdrop",
  screen: "glare",
  book: "prop",
  cup: "prop",
  bottle: "prop",
  vase: "prop",
  clock: "prop",
  bag: "prop",
  umbrella: "prop",
  teddy: "prop",
  phone: "prop",
  ball: "prop",
  skateboard: "prop",
  dog: "pet",
  cat: "pet",
  bird: "pet",
};

/** Pets first (a co-star steals the show), then props, backdrops, and screens last. */
const ROLE_RANK: Record<Role, number> = { pet: 3, prop: 2, backdrop: 1, glare: 0 };

/** At most this many highlights at once: more and the frame reads as clutter. */
export const MOST_HIGHLIGHTS = 3;

export interface Seen {
  thing: Thing;
  role: Role;
  /** In the viewfinder's space (unmirrored), like the plan's boxes. */
  box: FrameBox;
  score: number;
}

export interface Detection {
  categoryName: string;
  score: number;
  /** Pixels in the camera's frame. */
  originX: number;
  originY: number;
  width: number;
  height: number;
}

const isDetected = (name: string): name is keyof typeof THINGS => Object.hasOwn(THINGS, name);

const THING_NAMES = new Set<string>(Object.values(THINGS));

/** Whether a name (from storage, say) is one of the things Director points out. */
export const isThing = (name: string): name is Thing => THING_NAMES.has(name);

/**
 * The detections worth a highlight, in the viewfinder's space: cropped to what it shows,
 * and dropped when they're mostly outside it.
 */
export function seenIn(
  detections: readonly Detection[],
  frameWidth: number,
  frameHeight: number,
): Seen[] {
  const crop = viewCrop(frameWidth, frameHeight);
  return detections.flatMap((detection) => {
    if (!isDetected(detection.categoryName)) {
      return [];
    }
    const thing = THINGS[detection.categoryName];
    const left = Math.max(0, (detection.originX - crop.x) / crop.width);
    const top = Math.max(0, (detection.originY - crop.y) / crop.height);
    const right = Math.min(1, (detection.originX + detection.width - crop.x) / crop.width);
    const bottom = Math.min(1, (detection.originY + detection.height - crop.y) / crop.height);
    const width = right - left;
    const height = bottom - top;
    if (width < 0.04 || height < 0.04) {
      return [];
    }
    return [
      {
        thing,
        role: ROLES[thing],
        box: { x: left, y: top, width, height },
        score: detection.score,
      },
    ];
  });
}

/** The words a plan may use for a landmark the detector knows, beyond the things' own names. */
const SYNONYMS: Record<string, Thing> = {
  tree: "plant",
  trees: "plant",
  plants: "plant",
  flowers: "plant",
  sofa: "couch",
  desk: "table",
  tv: "screen",
  television: "screen",
  monitor: "screen",
  laptop: "screen",
  bicycle: "bike",
  bookshelf: "book",
  books: "book",
  mug: "cup",
};

/**
 * The thing the detector can find for a shot's landmark ("tree" → plant, "the sofa" →
 * couch), or null when it's nothing the detector knows (a mirror, a window, the sea).
 */
export function thingFor(landmark: string | null): Thing | null {
  const words = landmark?.toLowerCase().match(/\p{Letter}+/gu) ?? [];
  for (const word of words) {
    const thing = SYNONYMS[word] ?? word;
    if (isThing(thing)) {
      return thing;
    }
  }
  return null;
}

/** How long a thing stays highlighted after the detector last saw it. */
export const HOLD_SECONDS = 0.8;

/**
 * What stays highlighted: this look's things, and the ones seen within the last moment,
 * so a single frame the detector misses doesn't make a lasso blink out and back.
 */
export function held(
  previous: readonly (Seen & { at: number })[],
  fresh: readonly Seen[],
  now: number,
): (Seen & { at: number })[] {
  const kept = new Map(
    previous.filter((item) => now - item.at <= HOLD_SECONDS).map((item) => [item.thing, item]),
  );
  for (const item of fresh) {
    kept.set(item.thing, { ...item, at: now });
  }
  return [...kept.values()];
}

/**
 * The few things to highlight: the shot's own landmark when the detector sees it (a
 * "plant" for "Stand near a tree"), then by role, then by how sure and how big, one of
 * each kind.
 */
export function highlights(seen: readonly Seen[], landmark: string | null): Seen[] {
  const wanted = thingFor(landmark);
  const rank = (item: Seen) =>
    (item.thing === wanted ? 10 : 0) +
    ROLE_RANK[item.role] +
    item.score * Math.sqrt(item.box.width * item.box.height);
  const best = new Map<Thing, Seen>();
  for (const item of [...seen].sort((a, b) => rank(b) - rank(a))) {
    if (!best.has(item.thing)) {
      best.set(item.thing, item);
    }
  }
  return [...best.values()].slice(0, MOST_HIGHLIGHTS);
}

/**
 * The scene check with its landmark where the phone sees it now. Gemini's box is from a
 * frame a few seconds old (or, from a stand-in, absent); the detector's is from this one
 * and follows the camera, so it wins whenever the detector finds the landmark. Without a
 * check yet, the landmark alone is enough to draw the walk to it.
 */
export function grounded(
  check: SceneCheck | null,
  things: readonly Seen[],
  landmark: string | null,
): SceneCheck | null {
  const wanted = thingFor(landmark);
  const found = things.find((item) => item.thing === wanted);
  if (!(found && landmark)) {
    return check;
  }
  const seen = { label: landmark, box: found.box };
  if (check) {
    return { ...check, landmark: seen };
  }
  return {
    inPlace: false,
    instruction: "",
    direction: "none",
    distanceMeters: null,
    landmark: seen,
    lighting: "good",
  };
}
