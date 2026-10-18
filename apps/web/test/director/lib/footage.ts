/**
 * Stand-ins for the camera's footage, made in the page: a canvas to draw on, a short
 * video recorded from one, a photo, and reading a pixel back.
 */

export function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("no 2D canvas in this browser");
  }
  return { canvas, ctx };
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * A WebM about `seconds` long, the frame filled with each of `colors` in turn for an
 * equal part of it.
 */
export async function recordClip(
  seconds: number,
  colors: readonly string[],
  { width = 160, height = 90 } = {},
): Promise<Blob> {
  const { canvas, ctx } = canvasOf(width, height);
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  const start = performance.now();
  for (;;) {
    const elapsed = (performance.now() - start) / 1000;
    if (elapsed >= seconds) {
      break;
    }
    const part = Math.min(colors.length - 1, Math.floor((elapsed / seconds) * colors.length));
    ctx.fillStyle = colors[part] ?? "black";
    ctx.fillRect(0, 0, width, height);
    await nextFrame();
  }
  recorder.stop();
  await stopped;
  return new Blob(chunks, { type: "video/webm" });
}

/** A PNG filled with `color`. */
export function photoOf(color: string, width = 90, height = 160): Promise<Blob> {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no photo"))), "image/png"),
  );
}

/** The colour at (`x`, `y`) of a picture, as [red, green, blue]. */
export function pixel(
  source: CanvasImageSource,
  width: number,
  height: number,
  x: number,
  y: number,
) {
  const { ctx } = canvasOf(width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
  return [r, g, b];
}

/** A picture (an image URL or a blob) loaded, to read its size and pixels. */
export async function imageOf(picture: string | Blob): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = typeof picture === "string" ? picture : URL.createObjectURL(picture);
  await image.decode();
  return image;
}

/** Mostly red, green or blue. */
export function hue([r = 0, g = 0, b = 0]: readonly number[]) {
  if (r > 150 && g < 100 && b < 100) {
    return "red";
  }
  if (g > 150 && r < 100 && b < 100) {
    return "green";
  }
  if (b > 150 && r < 100 && g < 100) {
    return "blue";
  }
  return "other";
}
