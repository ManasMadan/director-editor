/**
 * Director's doodles on the viewfinder, drawn on a canvas like a director's marker on a
 * monitor: arrows that say which way to walk, turn or move the phone, the spot to stand
 * on beside the scene's landmark, corner marks for the framing and the body to match.
 * Every line wobbles a little, the same way each frame (a seeded jitter), so it looks
 * hand-drawn but holds still; arrows bob along their way so they read as "go this way".
 *
 * Positions are fractions of the 9:16 viewfinder. The plan's outline and Gemini's boxes
 * are in the camera's own frame; the front camera's preview is a mirror, so those flip
 * to land on what the member sees, while arrows and labels are drawn in screen space and
 * read the right way round.
 */
import type { CameraMove, FrameBox, SceneCheck, Shot } from "@repo/contracts/api";
import type { FramingHint } from "./framing";
import { BONES, type Body, type Point } from "./pose";

/** A small deterministic random sequence: the same seed draws the same wobble. */
function wobble(seed: number) {
  let state = Math.trunc(seed * 1_000_003) % 2_147_483_647 || 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647 - 0.5;
  };
}

export interface Pen {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}

function at(pen: Pen, p: Point): Point {
  return { x: p.x * pen.width, y: p.y * pen.height };
}

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

interface Stroke {
  color: string;
  width: number;
  seed: number;
  /** Marching dashes: the dash length in pixels, and the time they march by. */
  dash?: number;
  time: number;
}

export interface DoodleColors {
  /** The outline once the member matches it, and until they do. */
  locked: string;
  waiting: string;
  /** Moves of the phone, and labels. */
  ink: string;
  /** The shadow under every line and label's backing, for any picture behind. */
  shade: string;
}

function begin(pen: Pen, stroke: Stroke, shade: string) {
  const { ctx } = pen;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width * Math.max(1, pen.width / 400);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = shade;
  ctx.shadowBlur = 8;
  const dash = stroke.dash ?? 0;
  ctx.setLineDash(dash > 0 ? [dash, dash * 0.8] : []);
  ctx.lineDashOffset = dash > 0 ? -stroke.time * 40 : 0;
}

/** A marker line along the arrow's curve, wobbling as a hand would. */
function sketchCurve(pen: Pen, arrow: Arrow, stroke: Stroke, shade: string) {
  const from = at(pen, arrow.from);
  const to = at(pen, arrow.to);
  const control = at(pen, controlOf(arrow));
  const jitter = Math.min(5, Math.hypot(to.x - from.x, to.y - from.y) * 0.015);
  const random = wobble(stroke.seed + arrow.from.x * 7 + arrow.from.y * 13 + arrow.to.x * 17);
  begin(pen, stroke, shade);
  pen.ctx.beginPath();
  pen.ctx.moveTo(from.x + random() * jitter, from.y + random() * jitter);
  pen.ctx.quadraticCurveTo(
    control.x + random() * jitter * 2,
    control.y + random() * jitter * 2,
    to.x,
    to.y,
  );
  pen.ctx.stroke();
}

function sketchLine(pen: Pen, a: Point, b: Point, stroke: Stroke, shade: string) {
  sketchCurve(pen, { from: a, to: b, bend: 0 }, stroke, shade);
}

/** An arrow: the curve, then a filled head along the curve's last direction. */
function sketchArrow(pen: Pen, arrow: Arrow, stroke: Stroke, shade: string) {
  sketchCurve(pen, arrow, stroke, shade);
  const tip = at(pen, arrow.to);
  const control = at(pen, controlOf(arrow));
  const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
  const size = Math.max(16, pen.width * 0.07);
  const { ctx } = pen;
  begin(pen, { ...stroke, dash: 0 }, shade);
  ctx.beginPath();
  ctx.moveTo(tip.x + Math.cos(angle) * size * 0.35, tip.y + Math.sin(angle) * size * 0.35);
  ctx.lineTo(tip.x - Math.cos(angle - 0.55) * size, tip.y - Math.sin(angle - 0.55) * size);
  ctx.lineTo(tip.x - Math.cos(angle + 0.55) * size, tip.y - Math.sin(angle + 0.55) * size);
  ctx.closePath();
  ctx.fill();
}

/** Corner marks, like a camera's framing guide, for the box the subject should fill. */
function sketchCorners(pen: Pen, box: FrameBox, stroke: Stroke, shade: string) {
  const arm = Math.min(box.width, box.height * (pen.height / pen.width)) * 0.22;
  const armY = (arm * pen.width) / pen.height;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const corners: [Point, Point, Point][] = [
    [
      { x: box.x, y: box.y + armY },
      { x: box.x, y: box.y },
      { x: box.x + arm, y: box.y },
    ],
    [
      { x: right - arm, y: box.y },
      { x: right, y: box.y },
      { x: right, y: box.y + armY },
    ],
    [
      { x: right, y: bottom - armY },
      { x: right, y: bottom },
      { x: right - arm, y: bottom },
    ],
    [
      { x: box.x + arm, y: bottom },
      { x: box.x, y: bottom },
      { x: box.x, y: bottom - armY },
    ],
  ];
  corners.forEach(([a, corner, b], index) => {
    sketchLine(pen, a, corner, { ...stroke, seed: stroke.seed + index }, shade);
    sketchLine(pen, corner, b, { ...stroke, seed: stroke.seed + index + 4 }, shade);
  });
}

/** A dashed loop round the box: the landmark Gemini saw. */
function sketchRing(pen: Pen, box: FrameBox, stroke: Stroke, shade: string) {
  const centre = at(pen, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  begin(pen, stroke, shade);
  pen.ctx.beginPath();
  pen.ctx.ellipse(
    centre.x,
    centre.y,
    (box.width * pen.width) / 2 + 6,
    (box.height * pen.height) / 2 + 6,
    -0.04,
    0,
    Math.PI * 2,
  );
  pen.ctx.stroke();
}

/** A stick figure through the body's joints, with a head over the nose. */
function sketchBody(pen: Pen, body: Body, stroke: Stroke, shade: string) {
  BONES.forEach(([from, to], index) => {
    const a = body[from];
    const b = body[to];
    if (a && b) {
      sketchLine(pen, a, b, { ...stroke, seed: index + 3 }, shade);
    }
  });
  if (body.nose) {
    const centre = at(pen, body.nose);
    begin(pen, stroke, shade);
    pen.ctx.beginPath();
    pen.ctx.arc(centre.x, centre.y, Math.max(10, pen.width * 0.05), 0, Math.PI * 2);
    pen.ctx.stroke();
  }
}

/** The spot to stand on: a ring on the floor with a cross, pulsing gently. */
function sketchSpot(pen: Pen, spot: Point, stroke: Stroke, shade: string) {
  const centre = at(pen, spot);
  const pulse = 1 + Math.sin(stroke.time * 4) * 0.08;
  const rx = pen.width * 0.09 * pulse;
  begin(pen, { ...stroke, dash: 0 }, shade);
  const { ctx } = pen;
  ctx.beginPath();
  ctx.ellipse(centre.x, centre.y, rx, rx * 0.38, 0, 0, Math.PI * 2);
  ctx.stroke();
  const cross = rx * 0.32;
  ctx.beginPath();
  ctx.moveTo(centre.x - cross, centre.y - cross * 0.5);
  ctx.lineTo(centre.x + cross, centre.y + cross * 0.5);
  ctx.moveTo(centre.x + cross, centre.y - cross * 0.5);
  ctx.lineTo(centre.x - cross, centre.y + cross * 0.5);
  ctx.stroke();
}

/** A circling arrow round the frame's lower middle: walk the camera round the subject. */
function sketchOrbit(pen: Pen, stroke: Stroke, shade: string) {
  const centre = at(pen, { x: 0.5, y: 0.6 });
  const rx = pen.width * 0.34;
  const ry = pen.height * 0.08;
  const end = Math.PI * 1.8;
  begin(pen, { ...stroke, dash: stroke.dash ?? 16 }, shade);
  pen.ctx.beginPath();
  pen.ctx.ellipse(centre.x, centre.y, rx, ry, 0, 0.2, end);
  pen.ctx.stroke();
  const tip = { x: 0.5 + 0.34 * Math.cos(end), y: 0.6 + 0.08 * Math.sin(end) };
  sketchArrow(
    pen,
    { from: { x: tip.x - 0.06, y: tip.y - 0.004 }, to: tip, bend: 0 },
    stroke,
    shade,
  );
}

/** A label on a dark tag, centred on `point` (screen space, so it always reads right). */
function sketchLabel(pen: Pen, text: string, point: Point, colors: DoodleColors, ink = colors.ink) {
  const { ctx } = pen;
  const size = Math.max(13, Math.round(pen.width * 0.042));
  ctx.save();
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  const width = ctx.measureText(text).width + size;
  const x = Math.max(width / 2 + 4, Math.min(pen.width - width / 2 - 4, point.x * pen.width));
  const y = point.y * pen.height;
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = colors.shade;
  ctx.beginPath();
  ctx.roundRect(x - width / 2, y - size * 0.85, width, size * 1.7, size * 0.85);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y);
  ctx.restore();
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
  labels: DoodleLabels;
}

/** Where the subject goes: corner marks, the body to match, and arrows to fit the frame. */
function drawSubject(pen: Pen, scene: DoodleScene, colors: DoodleColors, time: number) {
  const color = scene.matched ? colors.locked : colors.waiting;
  const box = flipBox(scene.shot.framing.subject, scene.mirrored);
  sketchCorners(pen, box, { color, width: 4, seed: 2, time }, colors.shade);
  // A body only when the plan has one to match: a shot of shoes is just its box.
  if (Object.keys(scene.target).length > 0) {
    sketchBody(
      pen,
      flipBody(scene.target, scene.mirrored),
      { color, width: 3, seed: 3, time },
      colors.shade,
    );
  }
  framingArrows(scene.framing, box).forEach((arrow, index) => {
    sketchArrow(
      pen,
      bob(arrow, time),
      { color: colors.waiting, width: 4, seed: 20 + index, time },
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

/** The walk to a landmark: its ring and name, the spot beside it, and the arrow there. */
function drawToLandmark(
  pen: Pen,
  landmark: NonNullable<SceneCheck["landmark"]>,
  walk: Walk,
  { scene, colors, time }: { scene: DoodleScene; colors: DoodleColors; time: number },
) {
  const box = flipBox(landmark.box, scene.mirrored);
  sketchRing(pen, box, { color: colors.locked, width: 3, seed: 5, dash: 10, time }, colors.shade);
  const middle = clamp(box.y + box.height * 0.35, OPEN_TOP, OPEN_BOTTOM);
  sketchLabel(pen, landmark.label, { x: box.x + box.width / 2, y: middle }, colors, colors.locked);
  const spot = spotBeside(box);
  sketchSpot(pen, spot, { color: walk.color, width: 4, seed: 7, time }, colors.shade);
  sketchLabel(pen, scene.labels.spot, { x: spot.x, y: spot.y + 0.045 }, colors, walk.color);
  if (walk.check.inPlace) {
    return;
  }
  const from = walkStart(walk.feet, spot, walk.check.direction);
  // Bowed upwards, whichever way it goes, like a hand-drawn "go there".
  const arrow = bob({ from, to: spot, bend: from.x > spot.x ? 0.06 : -0.06 }, time);
  sketchArrow(pen, arrow, { color: walk.color, width: 6, seed: 9, dash: 18, time }, colors.shade);
  if (walk.meters) {
    const top = controlOf(arrow);
    sketchLabel(pen, walk.meters, { x: top.x, y: top.y - 0.04 }, colors, walk.color);
  }
}

/** Getting to the spot: to the landmark when Gemini sees it, else the way it said to go. */
function drawWalk(pen: Pen, scene: DoodleScene, colors: DoodleColors, time: number) {
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
    drawToLandmark(pen, check.landmark, walk, { scene, colors, time });
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
    sketchLabel(pen, walk.meters, { x: arrow.to.x, y: arrow.to.y - 0.05 }, colors, walk.color);
  }
}

/** While recording: which way to move the phone now. */
function drawMove(pen: Pen, scene: DoodleScene, colors: DoodleColors, time: number) {
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
    sketchLabel(pen, scene.labels.move, { x: 0.5, y: 0.74 }, colors);
  }
}

/** Everything Director draws over the camera, for one frame `time` seconds in. */
export function drawDoodles(pen: Pen, scene: DoodleScene, colors: DoodleColors, time: number) {
  pen.ctx.clearRect(0, 0, pen.width, pen.height);
  drawSubject(pen, scene, colors, time);
  drawWalk(pen, scene, colors, time);
  drawMove(pen, scene, colors, time);
}
