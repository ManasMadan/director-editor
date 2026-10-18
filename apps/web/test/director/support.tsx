/**
 * For Director's tests.
 *
 * The hooks' tests: a hook rendered on a test page (renderPage's providers: next-intl, the
 * router stand-in), against an in-memory API when it calls one (the client package's
 * stand-in, as its own hooks' tests use), plus the browser's camera and recorder faked.
 *
 *   const api = standIn((os) => ({ director: { checkScene: os.director.checkScene.handler(…) } }));
 *   const hook = await renderHook(() => useSceneGuide(video, options), { api });
 *   await expect.poll(() => hook.current.scene).toEqual(answer);
 *
 * The pages' and components' tests: shorts, plans and takes as the AI stand-in serves them
 * (test/fake-ai.ts), and the phone's hardware: a camera that keeps drawing, and the tilt.
 */
import { ApiProvider } from "@repo/client";
import type { DirectorTake, Shot, ShotPlan } from "@repo/contracts/api";
import { type ReactNode, useState } from "react";
import { flushSync } from "react-dom";
import { expect, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import type { StandIn } from "../../../../packages/client/test/stand-in";
import { cleanup, renderPage } from "../render";

export { id, standIn } from "../../../../packages/client/test/stand-in";

export async function renderHook<T>(
  hook: () => T,
  options: { api?: StandIn; view?: (value: T) => ReactNode; url?: string } = {},
) {
  const state = { current: undefined as T, rerender: (): void => undefined };
  function Probe() {
    const [, setRenders] = useState(0);
    state.rerender = () => flushSync(() => setRenders((n) => n + 1));
    state.current = hook();
    return options.view?.(state.current) ?? null;
  }
  const { api } = options;
  await renderPage(
    api ? (
      <ApiProvider options={{ baseUrl: "http://api.test", fetch: api.fetch }}>
        <Probe />
      </ApiProvider>
    ) : (
      <Probe />
    ),
    { url: options.url },
  );
  return {
    /** The hook's latest return value. */
    get current() {
      return state.current;
    },
    /** Runs the hook again, after the test changed a value it reads. */
    rerender: () => state.rerender(),
    unmount: cleanup,
  };
}

/** The page's next task: React renders, promises settle, and no fake timer moves. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

/**
 * Waits for `check` to pass, like `expect.poll`, but without moving fake timers (under
 * `vi.useFakeTimers()` each of expect.poll's tries does): the test moves the clock itself.
 */
export async function until(check: () => void, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await nextTask();
    }
  }
}

/** A promise the test settles when it chooses. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A real WAV file of `seconds` of silence (16-bit mono, 8 kHz), as a link to play. */
export function silentWav(seconds: number) {
  const rate = 8000;
  const bytes = Math.round(rate * seconds) * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (at: number, value: string) => {
    for (const [i, char] of [...value].entries()) {
      view.setUint8(at + i, char.charCodeAt(0));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  return URL.createObjectURL(new Blob([view.buffer], { type: "audio/wav" }));
}

/** A <video> that says it has a frame to show (`readyState`), of a camera this size. */
export function cameraVideo({ readyState = 4, width = 1080, height = 1920 } = {}) {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: readyState });
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  return video;
}

/** A camera stream with a track to stop (from a canvas: no real camera here). */
export const cameraStream = () => document.createElement("canvas").captureStream();

/** The camera, answering each getUserMedia with what `answer` gives. */
export const fakeCamera = (answer: () => Promise<MediaStream> = async () => cameraStream()) =>
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(answer);

/**
 * MediaRecorder as the hooks use it: records nothing, hands its chunk over when stopped.
 * `FakeRecorder.last` is the one made most recently.
 */
export class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (type: string) => type.startsWith("video/webm");
  state: RecordingState = "inactive";
  timeslice: number | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    FakeRecorder.last = this;
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["take"]) });
    this.onstop?.();
  }
}

/** A video shot (or what `overrides` change). */
export function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    kind: "video",
    title: "The walk-in",
    purpose: "Opens the short",
    sourceStartSeconds: 0,
    sourceEndSeconds: 3,
    durationSeconds: 3,
    camera: "back",
    scene: "Stand by a tree",
    sceneLandmark: "tree",
    framing: {
      shotSize: "medium",
      subject: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
      note: "Centered",
    },
    phoneAngle: { pitch: 0, roll: 0, tolerance: 10, height: "chest" },
    pose: { description: "Standing", keypoints: [] },
    steps: [{ atSeconds: 0, instruction: "Walk in from the left", cameraMove: "static" }],
    script: [],
    ...overrides,
  };
}

/** A short of its own for each test: the AI stand-in keeps Director's answers per short. */
export const newVideoId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 11);

export function planShot(overrides: Partial<Shot> = {}): Shot {
  return {
    kind: "video",
    title: "Walk in",
    purpose: "Set the scene.",
    sourceStartSeconds: 1.2,
    sourceEndSeconds: 3.6,
    durationSeconds: 2,
    camera: "back",
    scene: "By a window",
    sceneLandmark: "window",
    framing: {
      shotSize: "medium",
      subject: { x: 0.25, y: 0.2, width: 0.5, height: 0.7 },
      note: "Waist up.",
    },
    phoneAngle: { pitch: 0, roll: 0, tolerance: 6, height: "chest" },
    pose: { description: "Standing.", keypoints: [] },
    steps: [{ atSeconds: 0, instruction: "Walk towards the camera.", cameraMove: "static" }],
    script: [],
    ...overrides,
  };
}

export function shotPlan(overrides: Partial<ShotPlan> = {}): ShotPlan {
  return {
    title: "Morning routine",
    format: "GRWM",
    summary: "Coffee, a window and a smile.",
    audio: "speech",
    durationSeconds: 75,
    shots: [planShot()],
    ...overrides,
  };
}

/** The short's plan, ready, as Director answers it. */
export const readyPlan = (videoId: string, plan: ShotPlan) =>
  commands.fakeDirector(videoId, { plan: { status: "ready", plan } });

/** A take as the AI service lists it (`createdAt` as JSON carries it). */
export function take(overrides: Partial<Omit<DirectorTake, "createdAt">> & { fileId: string }) {
  return {
    id: crypto.randomUUID(),
    shotIndex: 0,
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A canvas that keeps changing: something for a camera or a recorder to show. */
function movingCanvas(width = 360, height = 640) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  let frame = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 12) % 360} 70% 50%)`;
    ctx.fillRect(0, 0, width, height);
  };
  // A picture from the start, then a new one every frame or so.
  draw();
  const timer = window.setInterval(draw, 33);
  return { canvas, stop: () => window.clearInterval(timer) };
}

/**
 * The browser's camera, as a canvas's stream (with a tone for the microphone when sound
 * is asked for), or `refusal` thrown the way getUserMedia throws it.
 */
export function canvasCamera(refusal?: DOMException) {
  const opened: MediaStreamConstraints[] = [];
  const getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async (constraints = {}) => {
      opened.push(constraints);
      if (refusal) {
        throw refusal;
      }
      const { canvas, stop } = movingCanvas();
      const stream = canvas.captureStream(30);
      // The picture stops changing once the page turns the camera off.
      for (const track of stream.getTracks()) {
        const end = track.stop.bind(track);
        track.stop = () => {
          end();
          stop();
        };
      }
      if (constraints.audio) {
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const out = audio.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        for (const track of out.stream.getAudioTracks()) {
          stream.addTrack(track);
        }
      }
      return stream;
    });
  return { opened, getUserMedia };
}

/** A short WebM of a moving picture (with a tone when `withSound`), as a take records it. */
export async function recordVideo(seconds: number, withSound = false): Promise<Blob> {
  const { canvas, stop } = movingCanvas(180, 320);
  const stream = canvas.captureStream(30);
  let audio: AudioContext | null = null;
  if (withSound) {
    // Sound starts only after the page has been interacted with.
    await userEvent.click(document.body);
    audio = new AudioContext();
    await audio.resume();
    const tone = audio.createOscillator();
    const out = audio.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    for (const track of out.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start(100);
  const started = performance.now();
  await expect
    .poll(() => performance.now() - started, { timeout: seconds * 1000 + 5_000 })
    .toBeGreaterThanOrEqual(seconds * 1000);
  recorder.stop();
  await stopped;
  stop();
  await audio?.close();
  return new Blob(chunks, { type: "video/webm" });
}

/** A small JPEG photo. */
export async function photo(): Promise<Blob> {
  const { canvas, stop } = movingCanvas(90, 160);
  stop();
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob as Blob), "image/jpeg", 0.8),
  );
}

/**
 * The browser's speech recogniser, hearing what the test says (`hear`) instead of a
 * microphone. `FakeRecognizer.last` is the one the page made most recently.
 */
export class FakeRecognizer {
  static last: FakeRecognizer | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  started = 0;
  aborted = false;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognizer.last = this;
  }
  start() {
    this.started += 1;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
  }
  /** The member says `text`: still being heard (`final: false`) or a finished phrase. */
  hear(text: string, { final = true, confidence = 0.9 } = {}) {
    const best = { transcript: text, confidence };
    const result = Object.assign([best], { isFinal: final, item: () => best });
    this.onresult?.({ resultIndex: 0, results: [result] } as unknown as SpeechRecognitionEvent);
  }
  fail(error: string) {
    this.onerror?.({ error } as unknown as SpeechRecognitionErrorEvent);
  }
}

/** A browser with a speech recogniser (Chrome's prefixed one), the test's to speak into. */
export function fakeRecognizer() {
  FakeRecognizer.last = null;
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognizer);
}
