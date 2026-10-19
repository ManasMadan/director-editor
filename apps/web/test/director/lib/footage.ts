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

/**
 * A WebM about `seconds` long, the frame all `color` and the sound a steady `frequency`
 * tone: a take whose picture and sound each say which take it is. `audio` must be running.
 */
export async function recordToneClip(
  audio: AudioContext,
  seconds: number,
  color: string,
  frequency: number,
): Promise<Blob> {
  const { canvas, ctx } = canvasOf(160, 90);
  const tone = audio.createOscillator();
  tone.frequency.value = frequency;
  const sound = audio.createMediaStreamDestination();
  tone.connect(sound);
  tone.start();
  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...sound.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    // A pixel that changes each frame, so the canvas sends every one.
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 160, 90);
    ctx.fillStyle = `rgb(${Math.floor(performance.now()) % 256}, 0, 0)`;
    ctx.fillRect(0, 0, 1, 1);
    await nextFrame();
  }
  recorder.stop();
  await stopped;
  tone.stop();
  return new Blob(chunks, { type: "video/webm" });
}

/** Each frame a video shows as it plays through: when (its media time) and its hue. */
export async function playedFrames(video: Blob): Promise<{ time: number; hue: string }[]> {
  const element = document.createElement("video");
  element.muted = true;
  element.src = URL.createObjectURL(video);
  const { ctx } = canvasOf(16, 16);
  const frames: { time: number; hue: string }[] = [];
  const ended = new Promise((resolve) => {
    element.onended = resolve;
  });
  const onFrame = (_: number, metadata: VideoFrameCallbackMetadata) => {
    ctx.drawImage(element, 0, 0, 16, 16);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(8, 8, 1, 1).data;
    frames.push({ time: metadata.mediaTime, hue: hue([r, g, b]) });
    element.requestVideoFrameCallback(onFrame);
  };
  element.requestVideoFrameCallback(onFrame);
  await element.play();
  await ended;
  URL.revokeObjectURL(element.src);
  return frames;
}

/** Runs of a tone in `samples` at `rate`: which of `tones` (Hz) sounds, or none, and when. */
export function toneRuns(
  samples: Float32Array,
  rate: number,
  tones: readonly number[],
): { tone: number | null; start: number; end: number }[] {
  const window = Math.round(rate / 200);
  const runs: { tone: number | null; start: number; end: number }[] = [];
  for (let at = 0; at + window <= samples.length; at += window) {
    const powers = tones.map((tone) => goertzel(samples.subarray(at, at + window), rate, tone));
    const loudest = Math.max(...powers);
    const tone = loudest > 0.01 ? (tones[powers.indexOf(loudest)] ?? null) : null;
    const last = runs.at(-1);
    if (last && last.tone === tone) {
      last.end = (at + window) / rate;
    } else {
      runs.push({ tone, start: at / rate, end: (at + window) / rate });
    }
  }
  return runs;
}

/** How strongly `frequency` sounds in `samples` (Goertzel's algorithm), per sample. */
function goertzel(samples: Float32Array, rate: number, frequency: number) {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / rate);
  let previous = 0;
  let beforeThat = 0;
  for (const sample of samples) {
    const next = sample + coefficient * previous - beforeThat;
    beforeThat = previous;
    previous = next;
  }
  const power = previous ** 2 + beforeThat ** 2 - coefficient * previous * beforeThat;
  return power / samples.length ** 2;
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
