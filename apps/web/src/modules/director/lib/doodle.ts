/**
 * Director's doodles on the viewfinder, drawn like a director's marker on a monitor
 * (the look itself is lib/sketch.ts): arrows that say which way to walk, turn or move the
 * phone, the spot to stand on beside the scene's landmark, the body to step into, lassos
 * round what's worth using, a horizon to level, and stickers when the member gets it
 * right. Lines boil like hand-drawn animation, arrows bob along their way so they read as
 * "go this way", and everything tracked glides on springs (lib/spring.ts) instead of
 * jumping with each detection.
 *
 * Positions are fractions of the 9:16 viewfinder. The plan's outline and Gemini's boxes
 * are in the camera's own frame; the front camera's preview is a mirror, so those flip
 * to land on what the member sees, while arrows and labels are drawn in screen space and
 * read the right way round.
 */
import type { CameraMove, FrameBox, SceneCheck, Shot } from "@repo/contracts/api";
import type { FramingHint } from "./framing";
import { BONES, type Body, type Point } from "./pose";
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
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
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

function sketchLine(pen: Pen, a: Point, b: Point, stroke: Stroke, shade: string) {
  sketchCurve(pen, { from: a, to: b, bend: 0 }, stroke, shade);
}

/** An arrow: the curve, then an open chevron along the curve's last direction. */
function sketchArrow(pen: Pen, arrow: Arrow, stroke: Stroke, shade: string) {
  sketchCurve(pen, arrow, stroke, shade);
  const tip = at(pen, arrow.to);
  const control = at(pen, controlOf(arrow));
  const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
  const size = Math.max(18, pen.width * 0.075);
  ink(pen, { ...stroke, dash: 0 }, shade, (ctx) => {
    ctx.moveTo(tip.x - Math.cos(angle - 0.6) * size, tip.y - Math.sin(angle - 0.6) * size);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(tip.x - Math.cos(angle + 0.6) * size, tip.y - Math.sin(angle + 0.6) * size);
  });
}

/**
 * The body to step into: a soft ghost of it (fat translucent limbs and head) with a
 * stick figure over it, so it reads as "stand like this" from across a room.
 */
function sketchSilhouette(pen: Pen, body: Body, stroke: Stroke, shade: string, ghost: boolean) {
  const { ctx } = pen;
  const head = Math.max(12, pen.width * 0.06);
  if (ghost) {
    ctx.save();
    ctx.globalAlpha *= 0.2;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = pen.width * 0.09;
    ctx.beginPath();
    for (const [from, to] of BONES) {
      const a = body[from];
      const b = body[to];
      if (a && b) {
        const pa = at(pen, a);
        const pb = at(pen, b);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
    }
    ctx.stroke();
    if (body.nose) {
      const centre = at(pen, body.nose);
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, head * 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  BONES.forEach(([from, to], index) => {
    const a = body[from];
    const b = body[to];
    if (a && b) {
      sketchLine(pen, a, b, { ...stroke, seed: index + 3 }, shade);
    }
  });
  if (body.nose) {
    const centre = at(pen, body.nose);
    const random = wobble(stroke.seed + pen.boil * 7);
    ink(pen, stroke, shade, (c) => {
      c.ellipse(
        centre.x,
        centre.y,
        head * (1 + random() * 0.08),
        head * (1 + random() * 0.08),
        random(),
        0,
        Math.PI * 2,
      );
    });
  }
}

/** The spot to stand on: a ring on the floor with a cross, pulsing gently. */
function sketchSpot(pen: Pen, spot: Point, stroke: Stroke & { time: number }, shade: string) {
  const centre = at(pen, spot);
  const pulse = 1 + Math.sin(stroke.time * 4) * 0.08;
  const rx = pen.width * 0.09 * pulse;
  ink(pen, { ...stroke, dash: 0 }, shade, (ctx) => {
    ctx.ellipse(centre.x, centre.y, rx, rx * 0.38, 0, 0, Math.PI * 2);
    const cross = rx * 0.32;
    ctx.moveTo(centre.x - cross, centre.y - cross * 0.5);
    ctx.lineTo(centre.x + cross, centre.y + cross * 0.5);
    ctx.moveTo(centre.x + cross, centre.y - cross * 0.5);
    ctx.lineTo(centre.x - cross, centre.y + cross * 0.5);
  });
}

/** A circling arrow round the frame's lower middle: walk the camera round the subject. */
function sketchOrbit(pen: Pen, stroke: Stroke, shade: string) {
  const centre = at(pen, { x: 0.5, y: 0.6 });
  const end = Math.PI * 1.8;
  ink(pen, { ...stroke, dash: stroke.dash ?? 16 }, shade, (ctx) => {
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
  /** What moves the marks (the bob, the pulse, the marching dashes): still with reduced motion. */
  time: number;
  /** The clock itself, which stickers age by. */
  now: number;
}

const tagColors = (colors: DoodleColors) => ({
  paper: colors.paper,
  ink: colors.shade,
  shade: colors.shade,
});

/** Where the subject goes: the body to step into (or a lasso), and arrows to fit the frame. */
function drawSubject(pen: Pen, { scene, colors, time }: Drawing) {
  const color = scene.matched ? colors.locked : colors.waiting;
  const box = flipBox(scene.shot.framing.subject, scene.mirrored);
  if (Object.keys(scene.target).length > 0) {
    const body = flipBody(scene.target, scene.mirrored);
    sketchSilhouette(pen, body, { color, width: 4, seed: 3 }, colors.shade, !scene.recording);
  } else {
    // A shot of shoes is just where they go.
    sketchLasso(pen, box, { color, width: 4, seed: 2, dash: 14, time }, colors.shade);
  }
  framingArrows(scene.framing, box).forEach((arrow, index) => {
    sketchArrow(
      pen,
      bob(arrow, time),
      { color: colors.waiting, width: 5, seed: 20 + index },
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

/** The walk to a landmark: its lasso and name, the spot beside it, and the arrow there. */
function drawToLandmark(
  pen: Pen,
  landmark: NonNullable<SceneCheck["landmark"]>,
  walk: Walk,
  { scene, colors, time }: Drawing,
) {
  const box = flipBox(landmark.box, scene.mirrored);
  sketchLasso(pen, box, { color: colors.locked, width: 4, seed: 5, dash: 12, time }, colors.shade);
  const middle = clamp(box.y + box.height * 0.35, OPEN_TOP, OPEN_BOTTOM);
  sketchTag(pen, landmark.label, { x: box.x + box.width / 2, y: middle }, tagColors(colors), {
    tone: colors.locked,
    seed: 5,
  });
  const spot = spotBeside(box);
  sketchSpot(pen, spot, { color: walk.color, width: 5, seed: 7, time }, colors.shade);
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
  sketchArrow(pen, arrow, { color: walk.color, width: 7, seed: 9, dash: 18, time }, colors.shade);
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
  const stroke = { color: walk.color, width: 7, seed: 9, dash: 18, time };
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
  const stroke = { color: colors.ink, width: 7, seed: 11, time };
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
function drawHighlights(pen: Pen, { scene, colors, time }: Drawing) {
  scene.highlights.forEach((highlight, index) => {
    const box = flipBox(highlight.box, scene.mirrored);
    sketchLasso(
      pen,
      box,
      { color: colors.pop, width: 3.5, seed: 60 + index * 13, dash: 0, time },
      colors.shade,
    );
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

/** Everything Director draws over the camera, at `time` seconds (performance.now() / 1000). */
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
  if (scene.subject) {
    drawSubject(boiling, drawing);
  }
  drawHighlights(boiling, drawing);
  drawWalk(boiling, drawing);
  drawMove(boiling, drawing);
  drawStickers(boiling, drawing);
}
