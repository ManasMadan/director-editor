/**
 * For the Director hooks' tests: a hook rendered on a test page (renderPage's providers:
 * next-intl, the router stand-in), against an in-memory API when it calls one (the
 * client package's stand-in, as its own hooks' tests use), plus the browser's camera
 * and recorder faked.
 *
 *   const api = standIn((os) => ({ director: { checkScene: os.director.checkScene.handler(…) } }));
 *   const hook = await renderHook(() => useSceneGuide(video, options), { api });
 *   await expect.poll(() => hook.current.scene).toEqual(answer);
 */
import { ApiProvider } from "@repo/client";
import type { Shot } from "@repo/contracts/api";
import { type ReactNode, useState } from "react";
import { flushSync } from "react-dom";
import { vi } from "vitest";
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
export async function until(check: () => void) {
  const deadline = Date.now() + 5_000;
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
