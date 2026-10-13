import { afterEach, describe, expect, it, vi } from "vitest";
import { type CaptionInk, drawCaption } from "@/modules/director/lib/caption-draw";
import type { CaptionWord } from "@/modules/director/lib/captions";
import { canvasOf, hue } from "./footage";

const INK: CaptionInk = {
  text: "#ffffff",
  outline: "#000000",
  highlight: "#ff0000",
  box: "#0000ff",
};
const WIDTH = 360;
const HEIGHT = 640;

const words = (...list: [string, CaptionWord["state"]][]): CaptionWord[] =>
  list.map(([text, state]) => ({ text, state }));

function canvas() {
  const { ctx } = canvasOf(WIDTH, HEIGHT);
  return {
    ctx,
    fillText: vi.spyOn(ctx, "fillText"),
    strokeText: vi.spyOn(ctx, "strokeText"),
    roundRect: vi.spyOn(ctx, "roundRect"),
  };
}

/** Whether anything at all was painted. */
const painted = (ctx: CanvasRenderingContext2D) =>
  ctx.getImageData(0, 0, WIDTH, HEIGHT).data.some((value) => value > 0);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("drawing a caption", () => {
  it("draws nothing between lines, or with captions off", () => {
    const { ctx, fillText } = canvas();
    drawCaption(ctx, WIDTH, HEIGHT, null, "pop", INK);
    drawCaption(ctx, WIDTH, HEIGHT, words(["hi", "now"]), "off", INK);
    expect(fillText).not.toHaveBeenCalled();
    expect(painted(ctx)).toBe(false);
  });

  it("pops the words in capitals, outlined, the one being said on a red tag", () => {
    const { ctx, fillText, strokeText, roundRect } = canvas();
    drawCaption(
      ctx,
      WIDTH,
      HEIGHT,
      words(["make", "said"], ["it", "now"], ["pop", "next"]),
      "pop",
      INK,
    );
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(["MAKE", "IT", "POP"]);
    expect(strokeText.mock.calls.map(([text]) => text)).toEqual(["MAKE", "IT", "POP"]);
    // One row centred below the frame's middle, and one tag, behind "IT".
    const size = Math.round(WIDTH * 0.075);
    const ys = new Set(fillText.mock.calls.map(([, , y]) => y));
    expect(ys.size).toBe(1);
    expect([...ys][0]).toBeCloseTo(HEIGHT * 0.64);
    const xs = fillText.mock.calls.map(([, x]) => x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(roundRect).toHaveBeenCalledTimes(1);
    const tagAt = (x: number) =>
      hue(Array.from(ctx.getImageData(x, HEIGHT * 0.64 - size * 0.55, 1, 1).data));
    expect(tagAt((xs[1] ?? 0) + 3)).toBe("red");
    expect(tagAt((xs[0] ?? 0) + 3)).not.toBe("red");
    // The canvas's own settings are left as they were.
    expect(ctx.textBaseline).toBe("alphabetic");
  });

  it("boxes each row of classic captions, as written, wrapping a long line", () => {
    const { ctx, fillText, strokeText, roundRect } = canvas();
    const long = "This caption is far too long to fit across the frame on one row".split(" ");
    drawCaption(
      ctx,
      WIDTH,
      HEIGHT,
      long.map((text) => ({ text, state: "next" })),
      "classic",
      INK,
    );
    expect(fillText.mock.calls.map(([text]) => text)).toEqual(long);
    expect(strokeText).not.toHaveBeenCalled();
    const rows = new Set(fillText.mock.calls.map(([, , y]) => y));
    expect(rows.size).toBeGreaterThan(1);
    // A box behind every row, and each row inside the frame's margins.
    expect(roundRect).toHaveBeenCalledTimes(rows.size);
    for (const [x, , w] of roundRect.mock.calls) {
      expect(x).toBeGreaterThan(0);
      expect(x + w).toBeLessThan(WIDTH);
    }
    const [, firstX, firstY] = fillText.mock.calls[0] ?? [];
    const behind = ctx.getImageData((firstX ?? 0) - 4, (firstY ?? 0) - 10, 1, 1).data;
    expect(hue(Array.from(behind))).toBe("blue");
  });
});
