/**
 * The hand-drawn look of Director's doodles: a fat marker line with a soft dark edge (so
 * it reads over any picture, like a sticker), a wobble that boils (three drawings of each
 * line, cycled as hand-drawn animation does), lassos instead of boxes, sticker tags in a
 * marker hand, and the stickers themselves: stars, a clapperboard, a horizon line.
 *
 * The geometry is pure (and tested); the drawing calls only take a canvas `Pen`.
 */
import type { FrameBox } from "@repo/contracts/api";
import type { Point } from "./pose";

export interface Pen {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Which of the three drawings of every line to draw now (always 0 with reduced motion). */
  boil: number;
  /** The marker hand's font family. */
  font: string;
}

export interface Stroke {
  color: string;
  width: number;
  seed: number;
  /** Marching dashes: the dash length in pixels, and the time they march by. */
  dash?: number;
  time?: number;
}

/** Twelve drawings a second, three of each: the classic "line boil". */
const BOIL_FPS = 8;
const BOIL_DRAWINGS = 3;

export function boilFrame(time: number, still: boolean): number {
  return still ? 0 : Math.floor(time * BOIL_FPS) % BOIL_DRAWINGS;
}

/** A small deterministic random sequence: the same seed draws the same wobble. */
export function wobble(seed: number) {
  let state = Math.trunc(Math.abs(seed) * 1_000_003) % 2_147_483_647 || 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647 - 0.5;
  };
}

/** Pixels per point of line width: lines keep their weight on any size of screen. */
export const scaleOf = (pen: Pick<Pen, "width">) => Math.max(1, pen.width / 400);

export function at(pen: Pick<Pen, "width" | "height">, p: Point): Point {
  return { x: p.x * pen.width, y: p.y * pen.height };
}

/**
 * The points of a lasso round a box, the way a hand circles something: a little more
 * than one turn, starting top-left, slightly lumpy, the end overshooting the start.
 */
export function lassoPoints(box: FrameBox, seed: number, steps = 56): [Point, ...Point[]] {
  const random = wobble(seed);
  const third = random() * 6;
  const fifth = random() * 6;
  const start = -2.3 + random() * 0.4;
  const turns = 1.12;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const point = (index: number): Point => {
    const t = index / steps;
    const angle = start + t * turns * Math.PI * 2;
    const lump = 1 + 0.045 * Math.sin(3 * angle + third) + 0.03 * Math.sin(5 * angle + fifth);
    // A slight spiral, so the overshoot runs beside the start rather than over it.
    const grow = lump * (1 + t * 0.06);
    return {
      x: centre.x + Math.cos(angle) * (box.width / 2) * 1.08 * grow,
      y: centre.y + Math.sin(angle) * (box.height / 2) * 1.08 * grow,
    };
  };
  return [point(0), ...Array.from({ length: steps }, (_, index) => point(index + 1))];
}

/** A sticker's size as it pops in (overshooting, then settling), from its age in seconds. */
export function popScale(age: number): number {
  if (age <= 0) {
    return 0;
  }
  const t = Math.min(1, age / 0.38);
  // easeOutBack
  const c = 1.9;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

/** How visible a sticker is at `age` of its `life`: full, then fading out at the end. */
export function fadeOf(age: number, life: number): number {
  const fade = 0.35;
  if (age >= life) {
    return 0;
  }
  return Math.min(1, (life - age) / fade);
}

/** Five points out, five in: a star's outline around `centre`, `radius` across. */
export function starPoints(centre: Point, radius: number, seed: number): Point[] {
  const random = wobble(seed);
  return Array.from({ length: 10 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const reach = (index % 2 === 0 ? 1 : 0.46) * radius * (1 + random() * 0.08);
    return { x: centre.x + Math.cos(angle) * reach, y: centre.y + Math.sin(angle) * reach };
  });
}

/**
 * Draws `build`'s path twice: a wider soft dark edge, then the marker colour on top, so
 * the line stands out on a bright wall and a dark room alike.
 */
export function ink(
  pen: Pen,
  stroke: Stroke,
  shade: string,
  build: (ctx: CanvasRenderingContext2D) => void,
) {
  const { ctx } = pen;
  const scale = scaleOf(pen);
  const dash = stroke.dash ?? 0;
  const alpha = ctx.globalAlpha;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dash > 0 ? [dash * scale, dash * scale * 0.8] : []);
  ctx.lineDashOffset = dash > 0 ? -(stroke.time ?? 0) * 40 * scale : 0;
  ctx.globalAlpha = alpha * 0.5;
  ctx.strokeStyle = shade;
  ctx.lineWidth = (stroke.width + 4) * scale;
  ctx.beginPath();
  build(ctx);
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width * scale;
  ctx.beginPath();
  build(ctx);
  ctx.stroke();
  ctx.restore();
}

/**
 * A path through `points` (frame fractions), curving through the midpoints between them
 * and ending on the last.
 */
function tracePoints(
  pen: Pen,
  ctx: CanvasRenderingContext2D,
  [start, ...rest]: readonly [Point, ...Point[]],
) {
  const first = at(pen, start);
  ctx.moveTo(first.x, first.y);
  const pixels = rest.map((p) => at(pen, p));
  pixels.forEach((point, index) => {
    const next = pixels[index + 1];
    if (next) {
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
}

/** A lasso round `box`: what the camera screen draws instead of a bounding box. */
export function sketchLasso(pen: Pen, box: FrameBox, stroke: Stroke, shade: string) {
  const points = lassoPoints(box, stroke.seed + pen.boil * 101);
  ink(pen, stroke, shade, (ctx) => tracePoints(pen, ctx, points));
}

/**
 * A tag in the marker hand, like a sticker stuck on the frame: a white label, slightly
 * askew, with dark writing and a coloured edge (`tone`). Centred on `point`, kept inside
 * the frame, always the right way round.
 */
export function sketchTag(
  pen: Pen,
  text: string,
  point: Point,
  colors: { paper: string; ink: string; shade: string },
  { tone, seed, scale = 1 }: { tone: string; seed: number; scale?: number },
) {
  const { ctx } = pen;
  const size = Math.max(15, Math.round(pen.width * 0.05)) * scale;
  ctx.save();
  ctx.font = `${size}px ${pen.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + size * 1.1;
  const height = size * 1.55;
  const x = Math.max(width / 2 + 6, Math.min(pen.width - width / 2 - 6, point.x * pen.width));
  const y = Math.max(height, Math.min(pen.height - height, point.y * pen.height));
  ctx.translate(x, y);
  ctx.rotate(wobble(seed)() * 0.12);
  ctx.shadowColor = colors.shade;
  ctx.shadowBlur = 10 * scaleOf(pen);
  ctx.shadowOffsetY = 2 * scaleOf(pen);
  ctx.fillStyle = colors.paper;
  ctx.beginPath();
  ctx.roundRect(-width / 2, -height / 2, width, height, height / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2.5 * scaleOf(pen);
  ctx.strokeStyle = tone;
  ctx.stroke();
  ctx.fillStyle = colors.ink;
  ctx.fillText(text, 0, size * 0.06);
  ctx.restore();
}

/** A filled star sticker with a dark edge, popping in and spinning a little as it lands. */
export function sketchStar(
  pen: Pen,
  centre: Point,
  {
    radius,
    color,
    shade,
    age,
    seed,
  }: { radius: number; color: string; shade: string; age: number; seed: number },
) {
  const { ctx } = pen;
  const middle = at(pen, centre);
  const size = radius * pen.width * popScale(age);
  const points = starPoints({ x: 0, y: 0 }, size, seed + pen.boil * 31);
  ctx.save();
  ctx.translate(middle.x, middle.y);
  ctx.rotate((1 - Math.min(1, age / 0.5)) * 0.6 - 0.12);
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const [index, p] of points.entries()) {
    if (index === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = shade;
  ctx.lineWidth = 3.5 * scaleOf(pen);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Four little sparkle crosses bursting out from `centre` as a sticker lands. */
export function sketchSparkles(
  pen: Pen,
  centre: Point,
  { color, shade, age, reach }: { color: string; shade: string; age: number; reach: number },
) {
  const out = Math.min(1, age / 0.5);
  [0.6, 2.1, 3.7, 5.2].forEach((angle, index) => {
    const distance = reach * (0.6 + out * 0.6);
    const point = {
      x: centre.x + (Math.cos(angle) * distance * pen.height) / pen.width,
      y: centre.y + Math.sin(angle) * distance,
    };
    const arm = (0.018 + (index % 2) * 0.008) * (1 - out * 0.4);
    ink(pen, { color, width: 3, seed: 40 + index }, shade, (ctx) => {
      const p = at(pen, point);
      const a = arm * pen.width;
      ctx.moveTo(p.x - a, p.y);
      ctx.lineTo(p.x + a, p.y);
      ctx.moveTo(p.x, p.y - a);
      ctx.lineTo(p.x, p.y + a);
    });
  });
}

/**
 * The clapperboard that opens every take: the striped arm snaps shut a moment after it
 * lands, with the take's name written on the slate.
 */
export function sketchClapper(
  pen: Pen,
  centre: Point,
  {
    label,
    colors,
    age,
  }: {
    label: string;
    colors: { paper: string; ink: string; shade: string; pop: string };
    age: number;
  },
) {
  const { ctx } = pen;
  const scale = popScale(age);
  const width = pen.width * 0.34 * scale;
  const height = width * 0.62;
  const middle = at(pen, centre);
  const shut = Math.min(1, Math.max(0, (age - 0.25) / 0.12));
  ctx.save();
  ctx.translate(middle.x - width / 2, middle.y - height / 2);
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5 * scaleOf(pen);
  ctx.strokeStyle = colors.shade;
  ctx.fillStyle = colors.ink;
  ctx.beginPath();
  ctx.roundRect(0, height * 0.22, width, height * 0.78, width * 0.04);
  ctx.fill();
  ctx.stroke();
  // The arm, hinged at the left, from open to shut.
  ctx.save();
  ctx.translate(0, height * 0.22);
  ctx.rotate(-0.55 * (1 - shut));
  ctx.fillStyle = colors.paper;
  ctx.beginPath();
  ctx.roundRect(0, -height * 0.2, width, height * 0.2, width * 0.03);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors.ink;
  for (let stripe = 0; stripe < 5; stripe += 1) {
    const x = (stripe / 5) * width;
    ctx.beginPath();
    ctx.moveTo(x + width * 0.06, -height * 0.2);
    ctx.lineTo(x + width * 0.14, -height * 0.2);
    ctx.lineTo(x + width * 0.08, 0);
    ctx.lineTo(x, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.font = `${Math.round(height * 0.32)}px ${pen.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.pop;
  ctx.fillText(label, width / 2, height * 0.62);
  ctx.restore();
}

/**
 * A horizon drawn across the frame, turned by how far the phone leans off the plan's
 * angle; level, it straightens and turns `locked`. Small ticks at both ends, like a level.
 */
export function sketchHorizon(
  pen: Pen,
  {
    roll,
    level,
    colors,
    seed,
  }: {
    roll: number;
    level: boolean;
    colors: { locked: string; waiting: string; shade: string };
    seed: number;
  },
) {
  const angle = (-roll * Math.PI) / 180;
  const centre = at(pen, { x: 0.5, y: 0.5 });
  const half = pen.width * 0.36;
  const dx = Math.cos(angle) * half;
  const dy = Math.sin(angle) * half;
  const tick = pen.width * 0.03;
  const color = level ? colors.locked : colors.waiting;
  const random = wobble(seed + pen.boil * 17);
  ink(pen, { color, width: 3.5, seed, dash: level ? 0 : 12 }, colors.shade, (ctx) => {
    ctx.moveTo(centre.x - dx, centre.y - dy);
    ctx.quadraticCurveTo(
      centre.x + random() * 4,
      centre.y + random() * 4,
      centre.x + dx,
      centre.y + dy,
    );
    for (const side of [-1, 1]) {
      const end = { x: centre.x + side * dx, y: centre.y + side * dy };
      ctx.moveTo(end.x + Math.sin(angle) * tick, end.y - Math.cos(angle) * tick);
      ctx.lineTo(end.x - Math.sin(angle) * tick, end.y + Math.cos(angle) * tick);
    }
  });
}
