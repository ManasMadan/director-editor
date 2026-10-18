/**
 * Draws a caption onto a canvas: the same code for the preview's overlay and for the
 * frames of the finished short, so what the member sees while editing is what gets burned
 * in. Sizes are fractions of the canvas width, so a 360-pixel preview and the 720-pixel
 * render look alike.
 */
import { type CaptionStyle, type CaptionWord, wrapWords } from "./captions";

export interface CaptionInk {
  /** The words, and the outline that keeps them readable on any picture. */
  text: string;
  outline: string;
  /** The tag behind the word being said ("pop"). */
  highlight: string;
  /** The box behind each row ("classic"). */
  box: string;
}

/** Where the caption's middle sits, from the top: over the chest, clear of YouTube's UI. */
const CENTRE_Y = 0.64;
const MAX_WIDTH = 0.84;

interface Look {
  size: number;
  weight: number;
  lineHeight: number;
  upper: boolean;
}

const LOOKS: Record<Exclude<CaptionStyle, "off">, Look> = {
  pop: { size: 0.075, weight: 800, lineHeight: 1.3, upper: true },
  classic: { size: 0.05, weight: 600, lineHeight: 1.45, upper: false },
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h * 0.22);
  ctx.fill();
}

export function drawCaption(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  words: readonly CaptionWord[] | null,
  style: CaptionStyle,
  ink: CaptionInk,
  /** Where the caption's middle sits, as a fraction of the height (a split's seam, say). */
  centreY = CENTRE_Y,
) {
  if (!words || style === "off") {
    return;
  }
  const look = LOOKS[style];
  const size = Math.round(width * look.size);
  const shown = words.map((word) => ({
    ...word,
    text: look.upper ? word.text.toLocaleUpperCase() : word.text,
  }));
  ctx.save();
  ctx.font = `${look.weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const space = ctx.measureText(" ").width;
  const rows = wrapWords(shown, (text) => ctx.measureText(text).width, width * MAX_WIDTH);
  const rowHeight = size * look.lineHeight;
  const top = height * centreY - (rows.length * rowHeight) / 2;
  rows.forEach((row, index) => {
    const measured = row.map((word) => ({ word, w: ctx.measureText(word.text).width }));
    const rowWidth = measured.reduce((sum, { w }) => sum + w, 0) + space * (row.length - 1);
    const y = top + rowHeight * (index + 0.5);
    let x = (width - rowWidth) / 2;
    if (style === "classic") {
      ctx.fillStyle = ink.box;
      roundRect(ctx, x - size * 0.35, y - rowHeight / 2, rowWidth + size * 0.7, rowHeight);
    }
    measured.forEach(({ word, w }) => {
      if (style === "pop" && word.state === "now") {
        ctx.fillStyle = ink.highlight;
        roundRect(ctx, x - size * 0.15, y - size * 0.62, w + size * 0.3, size * 1.24);
      }
      if (style === "pop") {
        ctx.strokeStyle = ink.outline;
        ctx.lineWidth = size * 0.2;
        ctx.strokeText(word.text, x, y);
      }
      ctx.fillStyle = ink.text;
      ctx.fillText(word.text, x, y);
      x += w + space;
    });
  });
  ctx.restore();
}
