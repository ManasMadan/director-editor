/**
 * Stand-ins for the camera's footage, made in the page: a canvas to draw on, a short
 * video recorded from one, a photo, a WAV of chosen samples, and reading a pixel back.
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

/** Mono 16-bit PCM WAV of `samples` (from -1 to 1) at `rate`. */
export function wavOf(samples: readonly number[], rate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(at + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (const [at, sample] of samples.entries()) {
    view.setInt16(44 + at * 2, Math.round(sample * 32_767), true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
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
