/**
 * Paints one frame of the finished video onto the render's canvas, as lib/scene.ts says
 * it looks at that moment: the camera picture and the asset in their boxes (cropped to
 * cover, or a graphic with words fitted whole on a dark ground), graded; a gap's B-roll
 * over the camera (a clip, or a still slowly pushing in); the overlays, marks and words;
 * and the end card. Never a black frame: a gap with nothing chosen holds the nearest
 * take's picture.
 */
import type { FrameBox, ShotPlan } from "@repo/contracts/api";
import type { Clip } from "./edit";
import { type Scene, sceneAt } from "./scene";

/** An asset or a gap's fill, ready to draw. */
export type Visual =
  | { kind: "image"; image: ImageBitmap }
  | { kind: "video"; video: HTMLVideoElement };

/** A picture to draw and its natural size. */
export interface Picture {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/** How much a still slowly zooms in over its time on screen (as a photo take does). */
const PUSH_IN = 0.06;
const GROUND = "#111111";
const LOWER_THIRD = "#6d28d9";
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function pictureOf(visual: Visual): Picture | null {
  if (visual.kind === "image") {
    return { source: visual.image, width: visual.image.width, height: visual.image.height };
  }
  const { video } = visual;
  return video.videoWidth > 0
    ? { source: video, width: video.videoWidth, height: video.videoHeight }
    : null;
}

/** Draws `picture` into `box` (fractions of the canvas) without distorting it. */
export function drawInto(
  ctx: CanvasRenderingContext2D,
  picture: Picture,
  box: FrameBox,
  { fit = "cover", zoom = 1, filter = null }: { fit?: "cover" | "contain"; zoom?: number; filter?: string | null } = {},
) {
  const { width: cw, height: ch } = ctx.canvas;
  const bx = box.x * cw;
  const by = box.y * ch;
  const bw = box.width * cw;
  const bh = box.height * ch;
  const fitScale =
    fit === "cover"
      ? Math.max(bw / picture.width, bh / picture.height)
      : Math.min(bw / picture.width, bh / picture.height);
  const scale = fitScale * zoom;
  const w = picture.width * scale;
  const h = picture.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx, by, bw, bh);
  ctx.clip();
  if (fit === "contain") {
    ctx.fillStyle = GROUND;
    ctx.fillRect(bx, by, bw, bh);
  }
  ctx.filter = filter ?? "none";
  ctx.drawImage(picture.source, bx + (bw - w) / 2, by + (bh - h) / 2, w, h);
  ctx.restore();
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Scene["marks"][number]) {
  const { width: cw, height: ch } = ctx.canvas;
  const x = mark.box.x * cw;
  const y = mark.box.y * ch;
  const w = mark.box.width * cw;
  const h = mark.box.height * ch;
  ctx.save();
  ctx.strokeStyle = mark.color ?? "#ef4444";
  ctx.fillStyle = mark.color ?? "#facc15";
  ctx.lineWidth = Math.max(4, cw * 0.008);
  ctx.lineCap = "round";
  ctx.beginPath();
  switch (mark.mark) {
    case "circle":
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * mark.drawn);
      break;
    case "underline":
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w * mark.drawn, y + h);
      break;
    case "highlight":
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, y, w * mark.drawn, h);
      break;
    case "arrow":
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w * mark.drawn, y + h - h * mark.drawn);
      break;
    case "tick":
      ctx.moveTo(x, y + h * 0.55);
      ctx.lineTo(x + w * 0.4, y + h);
      ctx.lineTo(x + w, y);
      break;
    case "cross":
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      break;
    default:
      ctx.rect(x, y, w, h);
  }
  ctx.stroke();
  ctx.restore();
}

const WORDS_Y: Record<Scene["words"][number]["position"], number> = {
  top: 0.12,
  middle: 0.45,
  bottom: 0.8,
  "between-halves": 0.5,
};

function drawWords(ctx: CanvasRenderingContext2D, words: Scene["words"][number], index: number) {
  const { width: cw, height: ch } = ctx.canvas;
  const title = words.style === "title";
  const size = Math.round(cw * (title ? 0.075 : 0.05));
  ctx.save();
  ctx.globalAlpha = words.shown;
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textBaseline = "middle";
  const text = words.text.length > 60 ? `${words.text.slice(0, 59)}…` : words.text;
  const width = Math.min(ctx.measureText(text).width, cw * 0.86);
  // A lower third sits on the left in a bar; a title, label or callout is centred.
  const lower = words.style === "lower-third";
  const y = ch * WORDS_Y[words.position] + index * size * 1.6;
  const x = lower ? cw * 0.06 : (cw - width) / 2;
  if (!title) {
    ctx.fillStyle = words.highlight ?? (lower ? LOWER_THIRD : "rgba(0,0,0,0.65)");
    ctx.beginPath();
    ctx.roundRect(x - size * 0.4, y - size * 0.75, width + size * 0.8, size * 1.5, size * 0.3);
    ctx.fill();
  } else {
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = size * 0.18;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y, cw * 0.86);
  }
  ctx.fillStyle = words.color ?? "#ffffff";
  ctx.fillText(text, x, y, cw * 0.86);
  ctx.restore();
}

function drawEndCard(
  ctx: CanvasRenderingContext2D,
  card: NonNullable<Scene["endCard"]>,
  visual: Visual | undefined,
  filter: string | null,
) {
  const { width: cw, height: ch } = ctx.canvas;
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, cw, ch);
  const picture = visual ? pictureOf(visual) : null;
  if (picture) {
    drawInto(ctx, picture, { x: 0, y: 0, width: 1, height: 1 }, { fit: "contain", filter });
    return;
  }
  if (card.text) {
    drawWords(ctx, {
      text: card.text,
      style: "title",
      position: "middle",
      color: null,
      highlight: null,
      shown: 1,
    }, 0);
  }
}

export interface Composer {
  /**
   * Paints the frame `at` seconds into the edit, with the camera's picture now (null in a
   * skipped shot); returns where the captions sit.
   */
  paint: (at: number, camera: Picture | null) => number;
  /** Stops every B-roll clip playing. */
  stop: () => void;
}

/**
 * A painter for one render: `assets` holds each slot's chosen picture (asset ids and the
 * gap slots), `hold` the nearest take's picture for a gap with nothing chosen.
 */
export function composer(
  ctx: CanvasRenderingContext2D,
  plan: ShotPlan,
  clips: readonly Clip[],
  assets: ReadonlyMap<string, Visual>,
  hold: Picture | null,
): Composer {
  const { width: cw, height: ch } = ctx.canvas;
  // The last camera picture drawn, copied: what a skipped shot holds when nothing fills it.
  const held = document.createElement("canvas");
  held.width = cw;
  held.height = ch;
  const heldCtx = held.getContext("2d");
  let hasHeld = false;
  let playing: HTMLVideoElement | null = null;

  const playOnly = (video: HTMLVideoElement | null, seconds: number) => {
    if (playing && playing !== video) {
      playing.pause();
    }
    if (video && video.paused) {
      video.currentTime = video.duration > 0 ? seconds % video.duration : 0;
      void video.play().catch(() => undefined);
    }
    playing = video;
  };

  const visualPicture = (id: string | null | undefined) => {
    const visual = id ? assets.get(id) : undefined;
    return visual ? pictureOf(visual) : null;
  };

  return {
    paint(at, camera) {
      const scene = sceneAt(plan, clips, at);
      ctx.fillStyle = GROUND;
      ctx.fillRect(0, 0, cw, ch);
      const gapVisual = scene.gap ? assets.get(scene.gap.slotId) : undefined;
      playOnly(gapVisual?.kind === "video" ? gapVisual.video : null, scene.gap?.seconds ?? 0);
      const gapPicture = gapVisual ? pictureOf(gapVisual) : null;
      if (scene.gap && (gapPicture || !camera)) {
        // B-roll over the camera; a skipped shot with nothing chosen holds the nearest take.
        const picture =
          gapPicture ??
          (hasHeld ? { source: held, width: cw, height: ch } : hold);
        if (picture) {
          const zoom =
            gapVisual?.kind === "video" ? 1 : 1 + PUSH_IN * (scene.gap.seconds / Math.max(0.5, scene.gap.length));
          drawInto(ctx, picture, { x: 0, y: 0, width: 1, height: 1 }, { zoom, filter: scene.assetFilter ?? scene.cameraFilter });
        }
      } else {
        if (camera && scene.camera) {
          drawInto(ctx, camera, scene.camera, { filter: scene.cameraFilter });
        }
        const asset = scene.asset ? visualPicture(scene.asset.assetId) : null;
        if (scene.asset && asset) {
          drawInto(ctx, asset, scene.asset.box, { fit: scene.asset.fit, filter: scene.assetFilter });
        } else if (camera && !scene.camera) {
          // The asset this moment needs isn't there: the member's picture rather than nothing.
          drawInto(ctx, camera, { x: 0, y: 0, width: 1, height: 1 }, { filter: scene.cameraFilter });
        }
      }
      if (camera && heldCtx) {
        heldCtx.drawImage(ctx.canvas, 0, 0);
        hasHeld = true;
      }
      for (const overlay of scene.overlays) {
        const picture = visualPicture(overlay.assetId);
        if (picture) {
          ctx.save();
          ctx.globalAlpha = overlay.shown;
          drawInto(ctx, picture, overlay.box, { fit: overlay.fit, filter: scene.assetFilter });
          ctx.restore();
        }
      }
      for (const mark of scene.marks) {
        drawMark(ctx, mark);
      }
      if (scene.endCard) {
        drawEndCard(ctx, scene.endCard, scene.endCard.assetId ? assets.get(scene.endCard.assetId) : undefined, scene.assetFilter);
      }
      scene.words.forEach((words, index) => drawWords(ctx, words, index));
      return scene.captionsY;
    },
    stop() {
      playOnly(null, 0);
    },
  };
}
