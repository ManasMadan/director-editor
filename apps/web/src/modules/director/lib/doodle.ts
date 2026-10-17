/**
 * Director's doodles on the viewfinder, drawn in single pen lines (the look itself is
 * lib/sketch.ts) for someone filming for the first time: a little stick buddy striking the
 * pose to copy, whose face says how the set-up is going before Director does (a smile, a
 * "?" when it can't see you, a worried look and a sun when the light is poor, a grin and a
 * hop when you match it); footprints where to stand beside the scene's landmark; arrows
 * that say which way to walk, turn or move the phone; lassos round what's worth using; a
 * horizon to level; and stickers when the member gets it right. Few marks at a time, so
 * the frame stays calm. Lines boil like hand-drawn animation, arrows bob along their way
 * so they read as "go this way", and everything tracked glides on springs (lib/spring.ts)
 * instead of jumping with each detection.
 *
 * Positions are fractions of the 9:16 viewfinder. The plan's outline and Gemini's boxes
 * are in the camera's own frame; the front camera's preview is a mirror, so those flip
 * to land on what the member sees, while arrows and labels are drawn in screen space and
 * read the right way round.
 */
import type { CameraMove, FrameBox, SceneCheck, Shot } from "@repo/contracts/api";
import type { Light } from "./frame-stats";
import type { FramingHint } from "./framing";
import type { Body, Point } from "./pose";
import {
  at,
  boilFrame,
  fadeOf,
  ink,
  type Pen,
  popScale,
  type Stroke,
  scaleOf,
  sketchClapper,
  sketchHorizon,
  sketchLasso,
  sketchSparkles,
  sketchStar,
  sketchTag,
  softShadow,
  wobble,
} from "./sketch";
import type { Glider } from "./spring";

const clamp = (value: number, low = 0.06, high = 0.94) => Math.max(low, Math.min(high, value));

/**
 * The band of the viewfinder the camera screen's own cards leave clear (the shot's guides
 * above, the step, prompter and record button below): where the walking doodles go.
 */
export const OPEN_TOP = 0.36;
export const OPEN_BOTTOM = 0.6;

export const flipPoint = (p: Point, mirrored: boolean): Point =>
  mirrored ? { x: 1 - p.x, y: p.y } : p;

export const flipBox = (box: FrameBox, mirrored: boolean): FrameBox =>
  mirrored ? { ...box, x: 1 - box.x - box.width } : box;

export function flipBody(body: Body, mirrored: boolean): Body {
  return Object.fromEntries(
    Object.entries(body).map(([name, point]) => [name, flipPoint(point, mirrored)]),
  );
}

/** An arrow from `from` to `to`, bowed sideways by `bend` (a fraction of the frame). */
export interface Arrow {
  from: Point;
  to: Point;
  bend: number;
}

/** The point the arrow's curve bows towards, off its middle at right angles. */
export function controlOf({ from, to, bend }: Arrow): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: (from.x + to.x) / 2 - (dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };
}

/** The arrow for walking `direction` from where the member stands, in screen space. */
export function walkArrow(direction: SceneCheck["direction"], from: Point): Arrow | null {
  const reach = 0.3;
  switch (direction) {
    case "left":
      return { from, to: { x: clamp(from.x - reach), y: from.y }, bend: -0.05 };
    case "right":
      return { from, to: { x: clamp(from.x + reach), y: from.y }, bend: 0.05 };
    // Towards the camera reads as down the screen, the way a floor plan would draw it.
    case "forward":
      return { from, to: { x: from.x, y: clamp(from.y + 0.16) }, bend: 0 };
    case "back":
      return { from, to: { x: from.x, y: clamp(from.y - 0.16) }, bend: 0 };
    case "turn-left":
      return { from: { x: 0.64, y: 0.3 }, to: { x: 0.36, y: 0.3 }, bend: 0.1 };
    case "turn-right":
      return { from: { x: 0.36, y: 0.3 }, to: { x: 0.64, y: 0.3 }, bend: -0.1 };
    default:
      return null;
  }
}

/**
 * Where to stand for a landmark: beside it, on the side towards the frame's middle, at
 * its foot or as low as the open band allows.
 */
export function spotBeside(box: FrameBox): Point {
  const onLeft = box.x + box.width / 2 < 0.5;
  return {
    x: clamp(onLeft ? box.x + box.width + 0.1 : box.x - 0.1, 0.12, 0.88),
    y: clamp(box.y + box.height * 0.9, OPEN_TOP, OPEN_BOTTOM),
  };
}

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** The shortest walking arrow that still reads as one, as a fraction of the frame's width. */
const MIN_WALK = 0.32;

/** Which way along the frame a direction walks: -1 left, 1 right, 0 neither. */
function travelOf(direction: SceneCheck["direction"]): number {
  if (direction === "left" || direction === "turn-left") {
    return -1;
  }
  return direction === "right" || direction === "turn-right" ? 1 : 0;
}

/**
 * Where the arrow to the spot starts: at the member when the pose guide sees them far
 * enough off; otherwise far enough from the spot to read as an arrow, on the side that
 * makes it point the way Director said to go (towards the spot when it said neither).
 */
export function walkStart(
  person: Point | null,
  spot: Point,
  direction: SceneCheck["direction"],
): Point {
  const y = clamp(person?.y ?? OPEN_BOTTOM, OPEN_TOP, OPEN_BOTTOM);
  if (person && Math.abs(person.x - spot.x) >= MIN_WALK) {
    return { x: person.x, y };
  }
  const towards = Math.sign(spot.x - (person?.x ?? 0.5)) || 1;
  const travel = travelOf(direction) || towards;
  return { x: clamp(spot.x - travel * MIN_WALK), y };
}

/** Arrows around the box the person should fill, for the framing hint (screen space). */
export function framingArrows(hint: FramingHint | null, box: FrameBox): Arrow[] {
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Two opposite corners say "bigger" or "smaller" as well as four, with half the marks.
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
  ];
  const side = (dx: number): Arrow[] => [
    { from: { x: centre.x - dx, y: centre.y }, to: { x: centre.x + dx, y: centre.y }, bend: 0 },
  ];
  switch (hint) {
    // Bigger in frame: the corners pull out; smaller: they push in.
    case "come-closer":
      return corners.map((c) => ({
        from: lerp(centre, c, 0.55),
        to: lerp(centre, c, 0.92),
        bend: 0,
      }));
    case "step-back":
      return corners.map((c) => ({
        from: lerp(centre, c, 0.95),
        to: lerp(centre, c, 0.62),
        bend: 0,
      }));
    case "step-left":
    case "aim-left":
      return side(-0.14);
    case "step-right":
    case "aim-right":
      return side(0.14);
    default:
      return [];
  }
}

/** The arrow for a camera move while recording (screen space), or null for none. */
export function moveArrow(move: CameraMove): Arrow | null {
  const vertical = (from: number, to: number): Arrow => ({
    from: { x: 0.5, y: from },
    to: { x: 0.5, y: to },
    bend: 0,
  });
  const arrows: Partial<Record<CameraMove, Arrow>> = {
    up: vertical(0.64, 0.36),
    "tilt-up": { from: { x: 0.5, y: 0.62 }, to: { x: 0.5, y: 0.36 }, bend: 0.08 },
    down: vertical(0.36, 0.64),
    "tilt-down": { from: { x: 0.5, y: 0.38 }, to: { x: 0.5, y: 0.64 }, bend: -0.08 },
    left: { from: { x: 0.7, y: 0.5 }, to: { x: 0.3, y: 0.5 }, bend: 0 },
    right: { from: { x: 0.3, y: 0.5 }, to: { x: 0.7, y: 0.5 }, bend: 0 },
    forward: vertical(0.6, 0.42),
    back: vertical(0.42, 0.6),
  };
  return arrows[move] ?? null;
}

/** The arrow moved a little along its way and back, over and over: "go this way". */
export function bob(arrow: Arrow, time: number): Arrow {
  const dx = arrow.to.x - arrow.from.x;
  const dy = arrow.to.y - arrow.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const shift = ((Math.sin(time * 5) + 1) / 2) * 0.025;
  const move = (p: Point) => ({ x: p.x + (dx / length) * shift, y: p.y + (dy / length) * shift });
  return { from: move(arrow.from), to: move(arrow.to), bend: arrow.bend };
}

export interface DoodleColors {
  /** The outline once the member matches it, and until they do. */
  locked: string;
  waiting: string;
  /** The marker: moves of the phone, the walk. */
  ink: string;
  /** The soft dark edge under every line, and the writing on tags. */
  shade: string;
  /** Stickers and highlights. */
  pop: string;
  /** The tags' label stock. */
  paper: string;
  /** "Cut!" */
  record: string;
}

export type StickerKind = "star" | "nailed" | "clap" | "cut";

/** A sticker slapped on the frame for a moment: a cheer, the slate, the call to cut. */
export interface Sticker {
  id: number;
  kind: StickerKind;
  /** When it landed, in seconds (performance.now() / 1000). */
  born: number;
  at: Point;
  label: string;
}

const STICKER_LIFE: Record<StickerKind, number> = { star: 1.4, nailed: 1.9, clap: 1.4, cut: 1.1 };

export const stickerAlive = (sticker: Sticker, now: number) =>
  now - sticker.born < STICKER_LIFE[sticker.kind];

/** Something worth pointing out (lib/things.ts), named, in the viewfinder's unmirrored space. */
interface Highlight {
  key: string;
  label: string;
  box: FrameBox;
}

/** The words the doodles carry, in the member's language. */
interface DoodleLabels {
  /** "Stand here", at the spot. */
  spot: string;
  /** "5 m", along the walking arrow. */
  meters: string | null;
  /** "Tilt down", under the camera move's arrow. */
  move: string | null;
}

export interface DoodleScene {
  shot: Shot;
  /** The pose to match (camera frame), and whether the member holds it. */
  target: Body;
  matched: boolean;
  /** The front camera's preview is mirrored: camera-frame positions flip to match it. */
  mirrored: boolean;
  /** Where the member stands (their feet, camera frame), when the pose guide sees them. */
  person: Point | null;
  /** While getting into place: the framing hint and Gemini's latest scene check. */
  framing: FramingHint | null;
  scene: SceneCheck | null;
  /** While getting into place: the light, as the phone or Gemini judges it. */
  light: Light | null;
  /** Whether Gemini is still walking the member to their spot (useSceneGuide's `guiding`). */
  guided: boolean;
  /** While recording: the step's camera move. */
  move: CameraMove | null;
  recording: boolean;
  /** Whether to draw where the subject goes (not while Director looks at a shared screen). */
  subject: boolean;
  /** Reduced motion: the lines hold still and the arrows stop bobbing. */
  still: boolean;
  /** While setting up on a phone: how far it leans off the plan's angle, and whether it's level. */
  horizon: { roll: number; level: boolean } | null;
  highlights: readonly Highlight[];
  stickers: readonly Sticker[];
  labels: DoodleLabels;
}

/** How the buddy feels: its face says how the set-up is going before Director has to. */
export type BuddyMood = "happy" | "cheer" | "lost" | "oops";

/** A matched pose is a cheer; then the light (worth fixing first), then whether it sees you. */
export function moodOf({
  matched,
  light,
  framing,
}: Pick<DoodleScene, "matched" | "light" | "framing">): BuddyMood {
  if (matched) {
    return "cheer";
  }
  if (light && light !== "good") {
    return "oops";
  }
  return framing === "not-seen" ? "lost" : "happy";
}

/**
 * A stick buddy drawn from the pose to match, the way a child draws one: a round head, a
 * body down from it, arms and legs from the body's top and bottom (not shoulder and hip
 * bars), round hands and little feet pointing out. Positions as the pose's; the radius
 * as a fraction of the frame's width.
 */
export interface Buddy {
  head: Point | null;
  radius: number;
  /** Neck to hips. */
  spine: [Point, Point] | null;
  arms: Point[][];
  legs: Point[][];
  hands: Point[];
  feet: { at: Point; side: number }[];
}

const middleOf = (a: Point | undefined, b: Point | undefined): Point | undefined =>
  a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : (a ?? b);

/** A big friendly head, a little wider than the shoulders are apart, within what reads on a phone. */
const headRadius = (body: Body) =>
  body.left_shoulder && body.right_shoulder
    ? Math.min(0.15, Math.max(0.05, Math.abs(body.left_shoulder.x - body.right_shoulder.x) * 0.55))
    : 0.07;

export function buddyOf(body: Body): Buddy {
  const radius = headRadius(body);
  const neck = middleOf(body.left_shoulder, body.right_shoulder);
  const hips = middleOf(body.left_hip, body.right_hip);
  const head = body.nose ?? null;
  // The body starts under the chin when there's a head, so the two don't overlap.
  const top = neck && head ? { x: neck.x, y: Math.max(neck.y, head.y + radius * (9 / 16)) } : neck;
  const limb = (...points: (Point | undefined)[]) => points.filter((p): p is Point => !!p);
  const sides = [
    {
      elbow: body.left_elbow,
      wrist: body.left_wrist,
      knee: body.left_knee,
      ankle: body.left_ankle,
    },
    {
      elbow: body.right_elbow,
      wrist: body.right_wrist,
      knee: body.right_knee,
      ankle: body.right_ankle,
    },
  ];
  return {
    head,
    radius,
    spine: top && hips ? [top, hips] : null,
    arms: sides.map((side) => limb(top, side.elbow, side.wrist)).filter((arm) => arm.length > 1),
    legs: sides.map((side) => limb(hips, side.knee, side.ankle)).filter((leg) => leg.length > 1),
    hands: limb(body.left_wrist, body.right_wrist),
    feet: limb(body.left_ankle, body.right_ankle).map((ankle) => ({
      at: ankle,
      side: Math.sign(ankle.x - (hips ?? ankle).x) || 1,
    })),
  };
}

/** The scene with every tracked position glided towards its latest reading (lib/spring.ts). */
export function glideScene(scene: DoodleScene, glider: Glider): DoodleScene {
  const box = (key: string, b: FrameBox): FrameBox => {
    const [x = b.x, y = b.y, width = b.width, height = b.height] = glider.glide(key, [
      b.x,
      b.y,
      b.width,
      b.height,
    ]);
    return { x, y, width, height };
  };
  const person = scene.person;
  const [px = 0, py = 0] = person ? glider.glide("person", [person.x, person.y]) : [];
  const check = scene.scene;
  const landmark = check?.landmark;
  return {
    ...scene,
    person: person ? { x: px, y: py } : null,
    scene:
      check && landmark
        ? { ...check, landmark: { ...landmark, box: box("landmark", landmark.box) } }
        : check,
    highlights: scene.highlights.map((each) => ({
      ...each,
      box: box(`thing:${each.key}`, each.box),
    })),
  };
}

/** A marker line along the arrow's curve, wobbling as a hand would, boiling as it's drawn. */
function sketchCurve(pen: Pen, arrow: Arrow, stroke: Stroke, shade: string) {
  ink(pen, stroke, shade, (ctx) => {
    const from = at(pen, arrow.from);
    const to = at(pen, arrow.to);
    const control = at(pen, controlOf(arrow));
    const jitter = Math.min(6 * scaleOf(pen), Math.hypot(to.x - from.x, to.y - from.y) * 0.02);
    const random = wobble(
      stroke.seed + arrow.from.x * 7 + arrow.from.y * 13 + arrow.to.x * 17 + pen.boil * 101,
    );
    ctx.moveTo(from.x + random() * jitter, from.y + random() * jitter);
    ctx.quadraticCurveTo(
      control.x + random() * jitter * 2,
      control.y + random() * jitter * 2,
      to.x,
      to.y,
    );
  });
}

/** An arrow: the curve, then an open chevron along the curve's last direction. */
function sketchArrow(pen: Pen, arrow: Arrow, stroke: Stroke, shade: string) {
  sketchCurve(pen, arrow, stroke, shade);
  const tip = at(pen, arrow.to);
  const control = at(pen, controlOf(arrow));
  const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
  const size = Math.max(18, pen.width * 0.075);
  ink(pen, stroke, shade, (ctx) => {
    ctx.moveTo(tip.x - Math.cos(angle - 0.6) * size, tip.y - Math.sin(angle - 0.6) * size);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle + 0.6) * size, tip.y - Math.sin(angle + 0.6) * size);
  });
}

/** A pen path through `points` (pixels), corner to corner, as one line. */
function polyline(ctx: CanvasRenderingContext2D, [first, ...rest]: readonly Point[]) {
  if (!first) {
    return;
  }
  ctx.moveTo(first.x, first.y);
  for (const point of rest) {
    ctx.lineTo(point.x, point.y);
  }
}

/** A circle as its own piece of a path (no line joining it to what came before). */
function circle(ctx: CanvasRenderingContext2D, centre: Point, radius: number) {
  ctx.moveTo(centre.x + radius, centre.y);
  ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
}

/** The buddy, in pixels: as it stands now, with its breathing, hop and hand-drawn wobble. */
function buddyInPixels(pen: Pen, buddy: Buddy, mood: BuddyMood, time: number): Buddy {
  // Breathing lifts the head and arms a little; a cheer is a hop of the whole buddy.
  const breath = Math.sin(time * 2.2) * 0.004;
  const hop = mood === "cheer" ? -Math.abs(Math.sin(time * 7)) * 0.014 : 0;
  // Looking for the member, the head turns side to side.
  const look = mood === "lost" ? Math.sin(time * 1.6) * 0.008 : 0;
  const random = wobble(17 + pen.boil * 101);
  const jitter = 1.2 * scaleOf(pen);
  const place = (p: Point, lift: number, turn = 0): Point => {
    const pixel = at(pen, { x: p.x + turn, y: p.y + hop + lift });
    return { x: pixel.x + random() * jitter, y: pixel.y + random() * jitter };
  };
  const upper = (p: Point) => place(p, breath);
  return {
    head: buddy.head ? place(buddy.head, breath, look) : null,
    radius: buddy.radius * pen.width,
    spine: buddy.spine ? [upper(buddy.spine[0]), place(buddy.spine[1], 0)] : null,
    arms: buddy.arms.map((arm) => arm.map(upper)),
    legs: buddy.legs.map((leg) => leg.map((p) => place(p, 0))),
    hands: buddy.hands.map(upper),
    feet: buddy.feet.map((foot) => ({ ...foot, at: place(foot.at, 0) })),
  };
}

/** Whether the buddy's eyes are shut this moment: a quick blink every few seconds. */
const blinking = (time: number, still: boolean) => !still && time % 3.4 < 0.13;

/** Where the buddy's features go, in pixels. */
interface Face {
  head: Point;
  radius: number;
  eyeY: number;
  eyes: readonly number[];
  /** An eye's size. */
  dot: number;
}

/** A smile from corner to corner, `depth` of the head's radius deep. */
const smile =
  (wide: number, depth: number) =>
  (ctx: CanvasRenderingContext2D, { head, radius }: Face) => {
    ctx.moveTo(head.x - radius * wide, head.y + radius * 0.24);
    ctx.quadraticCurveTo(
      head.x,
      head.y + radius * depth,
      head.x + radius * wide,
      head.y + radius * 0.24,
    );
  };

/** Worried: brows up in the middle, and the corners of the mouth down. */
function worried(ctx: CanvasRenderingContext2D, { head, radius, eyeY, eyes, dot }: Face) {
  for (const [index, x] of eyes.entries()) {
    // Inner ends up: worried, not cross.
    const inward = index === 0 ? -1 : 1;
    ctx.moveTo(x - dot * 1.4, eyeY - dot * (2.6 + inward * 0.8));
    ctx.lineTo(x + dot * 1.4, eyeY - dot * (2.6 - inward * 0.8));
  }
  ctx.moveTo(head.x - radius * 0.3, head.y + radius * 0.52);
  ctx.quadraticCurveTo(
    head.x,
    head.y + radius * 0.28,
    head.x + radius * 0.3,
    head.y + radius * 0.52,
  );
}

/** The mouth (and brows) for each mood: a smile, a grin, an "o" looking for you, a worry. */
const EXPRESSIONS: Record<BuddyMood, (ctx: CanvasRenderingContext2D, face: Face) => void> = {
  happy: smile(0.32, 0.6),
  cheer: smile(0.44, 0.85),
  lost: (ctx, { head, radius }) =>
    circle(ctx, { x: head.x, y: head.y + radius * 0.42 }, radius * 0.13),
  oops: worried,
};

/** Eyes drawn as lines: happy arcs for a cheer (^ ^), or shut for a blink. */
function eyeLines(ctx: CanvasRenderingContext2D, { eyes, eyeY, dot }: Face, cheer: boolean) {
  for (const x of eyes) {
    if (cheer) {
      ctx.moveTo(x - dot * 1.6, eyeY + dot);
      ctx.quadraticCurveTo(x, eyeY - dot * 1.8, x + dot * 1.6, eyeY + dot);
    } else {
      ctx.moveTo(x - dot * 1.3, eyeY);
      ctx.lineTo(x + dot * 1.3, eyeY);
    }
  }
}

/** The buddy's face: two dot eyes (happy arcs for a cheer) and a mouth that says its mood. */
function sketchFace(
  pen: Pen,
  head: Point,
  radius: number,
  { mood, color, shade, time, still }: BuddyLook,
) {
  const face: Face = {
    head,
    radius,
    eyeY: head.y - radius * 0.12,
    eyes: [head.x - radius * 0.34, head.x + radius * 0.34],
    dot: Math.max(1.6 * scaleOf(pen), radius * 0.1),
  };
  const cheer = mood === "cheer";
  const open = !(cheer || blinking(time, still));
  ink(pen, { color, width: 2.6, seed: 31 }, shade, (ctx) => {
    if (!open) {
      eyeLines(ctx, face, cheer);
    }
    EXPRESSIONS[mood](ctx, face);
  });
  if (open) {
    // Open eyes are dots: filled, not rings.
    const { ctx } = pen;
    ctx.save();
    softShadow(pen, shade);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const x of face.eyes) {
      circle(ctx, { x, y: face.eyeY }, face.dot);
    }
    ctx.fill();
    ctx.restore();
  }
}

interface BuddyLook {
  mood: BuddyMood;
  color: string;
  shade: string;
  time: number;
  still: boolean;
}

/**
 * "?" by the buddy's head while it looks for the member, kept in frame on `side` (-1
 * left, 1 right): the side with more room, chosen from the pose rather than the wobbling
 * line, so it doesn't hop across a head right in the middle.
 */
function sketchWonder(
  pen: Pen,
  head: Point,
  { radius, side }: { radius: number; side: number },
  { color, shade, time }: BuddyLook,
) {
  const { ctx } = pen;
  const size = Math.round(radius * 1.2);
  const bounce = Math.sin(time * 3) * radius * 0.12;
  ctx.save();
  ctx.font = `${size}px ${pen.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  softShadow(pen, shade);
  ctx.fillStyle = color;
  ctx.fillText(
    "?",
    Math.max(size, Math.min(pen.width - size, head.x + side * radius * 1.5)),
    Math.max(size, head.y - radius * 1.1 + bounce),
  );
  ctx.restore();
}

/**
 * The buddy: head, body, arms, legs, hands and feet in one pen line, and its face. "?"
 * floats by its head while it looks for the member.
 */
function sketchBuddy(pen: Pen, buddy: Buddy, look: BuddyLook) {
  const drawn = buddyInPixels(pen, buddy, look.mood, look.time);
  const radius = drawn.radius;
  ink(pen, { color: look.color, width: 3.4, seed: 3 }, look.shade, (ctx) => {
    if (drawn.head) {
      circle(ctx, drawn.head, radius);
    }
    if (drawn.spine) {
      polyline(ctx, drawn.spine);
    }
    for (const limb of [...drawn.arms, ...drawn.legs]) {
      polyline(ctx, limb);
    }
    for (const hand of drawn.hands) {
      circle(ctx, hand, radius * 0.17);
    }
    for (const { at: ankle, side } of drawn.feet) {
      ctx.moveTo(ankle.x, ankle.y);
      ctx.quadraticCurveTo(
        ankle.x + side * radius * 0.25,
        ankle.y + radius * 0.2,
        ankle.x + side * radius * 0.6,
        ankle.y + radius * 0.14,
      );
    }
  });
  if (!drawn.head) {
    return;
  }
  sketchFace(pen, drawn.head, radius, look);
  if (look.mood === "lost") {
    sketchWonder(pen, drawn.head, { radius, side: (buddy.head?.x ?? 0) > 0.5 ? -1 : 1 }, look);
  }
}

/**
 * A little sun with its rays turning slowly: "let's find some light", beside the buddy's
 * head (or high in the open band without one).
 */
function sketchSun(
  pen: Pen,
  centre: Point,
  { color, shade, time }: Omit<BuddyLook, "mood" | "still">,
) {
  const middle = at(pen, centre);
  const radius = pen.width * 0.035;
  const turn = time * 0.6;
  ink(pen, { color, width: 3, seed: 51 }, shade, (ctx) => {
    circle(ctx, middle, radius);
    for (let ray = 0; ray < 8; ray += 1) {
      const angle = turn + (ray * Math.PI) / 4;
      const reach = ray % 2 === 0 ? 1.9 : 1.6;
      ctx.moveTo(
        middle.x + Math.cos(angle) * radius * 1.35,
        middle.y + Math.sin(angle) * radius * 1.35,
      );
      ctx.lineTo(
        middle.x + Math.cos(angle) * radius * reach,
        middle.y + Math.sin(angle) * radius * reach,
      );
    }
  });
}

/** Where to stand: two footprints side by side, breathing gently so the eye finds them. */
function sketchFootprints(pen: Pen, spot: Point, stroke: Stroke & { time: number }, shade: string) {
  const centre = at(pen, spot);
  const pulse = 1 + Math.sin(stroke.time * 4) * 0.06;
  const length = pen.width * 0.05 * pulse;
  const width = length * 0.42;
  ink(pen, stroke, shade, (ctx) => {
    for (const side of [-1, 1]) {
      const x = centre.x + side * width * 1.4;
      // Toes apart, heels together, the way people stand.
      ctx.moveTo(x + width, centre.y);
      ctx.ellipse(x, centre.y, width, length, side * 0.18, 0, Math.PI * 2);
    }
  });
}

/** A circling arrow round the frame's lower middle: walk the camera round the subject. */
function sketchOrbit(pen: Pen, stroke: Stroke, shade: string) {
  const centre = at(pen, { x: 0.5, y: 0.6 });
  const end = Math.PI * 1.8;
  ink(pen, stroke, shade, (ctx) => {
    ctx.ellipse(centre.x, centre.y, pen.width * 0.34, pen.height * 0.08, 0, 0.2, end);
  });
  const tip = { x: 0.5 + 0.34 * Math.cos(end), y: 0.6 + 0.08 * Math.sin(end) };
  sketchArrow(
    pen,
    { from: { x: tip.x - 0.06, y: tip.y - 0.004 }, to: tip, bend: 0 },
    stroke,
    shade,
  );
}

interface Drawing {
  scene: DoodleScene;
  colors: DoodleColors;
  /** What moves the marks (the bob, the pulse, the breath, the blink): still with reduced motion. */
  time: number;
  /** The clock itself, which stickers age by. */
  now: number;
}

const tagColors = (colors: DoodleColors) => ({
  paper: colors.paper,
  ink: colors.shade,
  shade: colors.shade,
});

/** Where the sun goes when the light needs fixing: by the buddy's head, on its roomier side. */
function sunBeside(buddy: Buddy | null): Point {
  if (!buddy?.head) {
    return { x: 0.8, y: OPEN_TOP };
  }
  const side = buddy.head.x > 0.5 ? -1 : 1;
  return {
    x: clamp(buddy.head.x + side * buddy.radius * 2.4),
    // The radius is a share of the frame's width; the frame is 9:16.
    y: clamp(buddy.head.y - buddy.radius * 0.3 * (9 / 16)),
  };
}

/** The buddy to copy, faded back while recording so the member watches themselves, not it. */
function drawBuddy(pen: Pen, target: Body, { scene, colors, time }: Drawing): Buddy {
  const buddy = buddyOf(flipBody(target, scene.mirrored));
  pen.ctx.save();
  pen.ctx.globalAlpha *= scene.recording ? 0.55 : 1;
  sketchBuddy(pen, buddy, {
    mood: moodOf(scene),
    color: scene.matched ? colors.locked : colors.ink,
    shade: colors.shade,
    time,
    still: scene.still,
  });
  pen.ctx.restore();
  return buddy;
}

/**
 * Where the subject goes: the buddy to copy (or a lasso round where it goes), arrows to
 * fit the frame, and a sun when the light needs fixing.
 */
function drawSubject(pen: Pen, drawing: Drawing) {
  const { scene, colors, time } = drawing;
  const box = flipBox(scene.shot.framing.subject, scene.mirrored);
  const posed = Object.keys(scene.target).length > 0;
  const buddy = posed ? drawBuddy(pen, scene.target, drawing) : null;
  if (!posed) {
    // A shot of shoes is just where they go.
    // No pose to match, so nothing to lock: it stays the waiting colour.
    sketchLasso(pen, box, { color: colors.waiting, width: 3, seed: 2 }, colors.shade);
  }
  if (moodOf(scene) === "oops") {
    sketchSun(pen, sunBeside(buddy), { color: colors.pop, shade: colors.shade, time });
  }
  framingArrows(scene.framing, box).forEach((arrow, index) => {
    sketchArrow(
      pen,
      bob(arrow, time),
      { color: colors.waiting, width: 4, seed: 20 + index },
      colors.shade,
    );
  });
}

interface Walk {
  check: SceneCheck;
  /** The member's feet on screen, when the pose guide sees them. */
  feet: Point | null;
  color: string;
  meters: string | null;
}

/** The walk to a landmark: its lasso and name, footprints beside it, and the arrow there. */
function drawToLandmark(
  pen: Pen,
  landmark: NonNullable<SceneCheck["landmark"]>,
  walk: Walk,
  { scene, colors, time }: Drawing,
) {
  const box = flipBox(landmark.box, scene.mirrored);
  sketchLasso(pen, box, { color: colors.locked, width: 3, seed: 5 }, colors.shade);
  const middle = clamp(box.y + box.height * 0.35, OPEN_TOP, OPEN_BOTTOM);
  sketchTag(pen, landmark.label, { x: box.x + box.width / 2, y: middle }, tagColors(colors), {
    tone: colors.locked,
    seed: 5,
  });
  const spot = spotBeside(box);
  sketchFootprints(pen, spot, { color: walk.color, width: 3, seed: 7, time }, colors.shade);
  sketchTag(pen, scene.labels.spot, { x: spot.x, y: spot.y + 0.05 }, tagColors(colors), {
    tone: walk.color,
    seed: 6,
  });
  if (walk.check.inPlace) {
    return;
  }
  const from = walkStart(walk.feet, spot, walk.check.direction);
  // Bowed upwards, whichever way it goes, like a hand-drawn "go there".
  const arrow = bob({ from, to: spot, bend: from.x > spot.x ? 0.06 : -0.06 }, time);
  sketchArrow(pen, arrow, { color: walk.color, width: 4.5, seed: 9 }, colors.shade);
  if (walk.meters) {
    const top = controlOf(arrow);
    sketchTag(pen, walk.meters, { x: top.x, y: top.y - 0.045 }, tagColors(colors), {
      tone: walk.color,
      seed: 8,
      scale: 0.85,
    });
  }
}

/** Getting to the spot: to the landmark when Gemini sees it, else the way it said to go. */
function drawWalk(pen: Pen, drawing: Drawing) {
  const { scene, colors, time } = drawing;
  const check = scene.scene;
  if (!check) {
    return;
  }
  const feet = scene.person ? flipPoint(scene.person, scene.mirrored) : null;
  const walk: Walk = {
    check,
    feet,
    color: check.inPlace ? colors.locked : colors.waiting,
    meters: scene.labels.meters,
  };
  if (check.landmark) {
    drawToLandmark(pen, check.landmark, walk, drawing);
    return;
  }
  // From the member's feet, lifted into the open band so no card hides the arrow.
  const person = { x: feet?.x ?? 0.5, y: clamp(feet?.y ?? OPEN_BOTTOM, OPEN_TOP, OPEN_BOTTOM) };
  const arrow = check.inPlace ? null : walkArrow(check.direction, person);
  if (!arrow) {
    return;
  }
  const stroke = { color: walk.color, width: 4.5, seed: 9 };
  sketchArrow(pen, bob(arrow, time), stroke, colors.shade);
  if (walk.meters) {
    sketchTag(pen, walk.meters, { x: arrow.to.x, y: arrow.to.y - 0.05 }, tagColors(colors), {
      tone: walk.color,
      seed: 8,
      scale: 0.85,
    });
  }
}

/** While recording: which way to move the phone now. */
function drawMove(pen: Pen, { scene, colors, time }: Drawing) {
  const stroke = { color: colors.ink, width: 4.5, seed: 11 };
  if (scene.move === "orbit") {
    sketchOrbit(pen, stroke, colors.shade);
  } else {
    const arrow = scene.move ? moveArrow(scene.move) : null;
    if (!arrow) {
      return;
    }
    sketchArrow(pen, bob(arrow, time), stroke, colors.shade);
  }
  if (scene.labels.move) {
    sketchTag(pen, scene.labels.move, { x: 0.5, y: 0.74 }, tagColors(colors), {
      tone: colors.ink,
      seed: 12,
    });
  }
}

/** What Director points out in the frame: a lasso round each, and its name on a tag. */
function drawHighlights(pen: Pen, { scene, colors }: Drawing) {
  scene.highlights.forEach((highlight, index) => {
    const box = flipBox(highlight.box, scene.mirrored);
    sketchLasso(pen, box, { color: colors.pop, width: 3, seed: 60 + index * 13 }, colors.shade);
    sketchTag(
      pen,
      highlight.label,
      { x: box.x + box.width / 2, y: Math.max(0.05, box.y - 0.025) },
      tagColors(colors),
      {
        tone: colors.pop,
        seed: 61 + index,
        scale: 0.8,
      },
    );
  });
}

/** The stickers landing on the frame, each popping in and fading out. */
function drawStickers(pen: Pen, { scene, colors, now }: Drawing) {
  const { ctx } = pen;
  for (const sticker of scene.stickers) {
    const age = now - sticker.born;
    const alpha = fadeOf(age, STICKER_LIFE[sticker.kind]);
    if (alpha <= 0 || age < 0) {
      continue;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    const star = { color: colors.pop, shade: colors.shade, age, seed: sticker.id };
    switch (sticker.kind) {
      case "star":
        sketchStar(pen, sticker.at, { ...star, radius: 0.07 });
        sketchSparkles(pen, sticker.at, {
          color: colors.pop,
          shade: colors.shade,
          age,
          reach: 0.07,
        });
        break;
      case "nailed":
        sketchSparkles(pen, sticker.at, {
          color: colors.pop,
          shade: colors.shade,
          age,
          reach: 0.1,
        });
        sketchStar(
          pen,
          { x: sticker.at.x + 0.22, y: sticker.at.y - 0.05 },
          { ...star, radius: 0.06 },
        );
        sketchTag(pen, sticker.label, sticker.at, tagColors(colors), {
          tone: colors.pop,
          seed: 70,
          scale: 1.3 * tagPop(age),
        });
        break;
      case "clap":
        sketchClapper(pen, sticker.at, {
          label: sticker.label,
          colors: { ...tagColors(colors), ink: colors.shade, pop: colors.paper },
          age,
        });
        break;
      case "cut":
        sketchTag(pen, sticker.label, sticker.at, tagColors(colors), {
          tone: colors.record,
          seed: 71,
          scale: 1.4 * tagPop(age),
        });
        break;
    }
    ctx.restore();
  }
}

/** A tag can't be drawn at size zero: the first frames of a pop start just above it. */
const tagPop = (age: number) => Math.max(0.05, popScale(age));

/** Whether Director is walking the member to their spot: a direction to go, not there yet. */
export const walking = (check: SceneCheck | null) =>
  check !== null && !check.inPlace && (check.landmark !== null || check.direction !== "none");

/**
 * Everything Director draws over the camera, at `time` seconds (performance.now() / 1000).
 * One thing at a time: while Gemini walks the member to their spot, the walk is all it
 * draws; the buddy to copy and the props worth using come once they're there, or once
 * Gemini can no longer guide the walk (out of reach, or its checks spent).
 */
export function drawDoodles(
  pen: Omit<Pen, "boil">,
  scene: DoodleScene,
  colors: DoodleColors,
  time: number,
) {
  // Reduced motion: every mark holds still (stickers still come and go, by the clock).
  const drawing: Drawing = { scene, colors, time: scene.still ? 0 : time, now: time };
  const boiling: Pen = { ...pen, boil: boilFrame(time, scene.still) };
  boiling.ctx.clearRect(0, 0, pen.width, pen.height);
  if (scene.horizon) {
    sketchHorizon(boiling, { ...scene.horizon, colors, seed: 90 });
  }
  const settled = !(scene.guided && walking(scene.scene));
  if (scene.subject && settled) {
    drawSubject(boiling, drawing);
  }
  if (settled) {
    drawHighlights(boiling, drawing);
  }
  drawWalk(boiling, drawing);
  drawMove(boiling, drawing);
  drawStickers(boiling, drawing);
}
