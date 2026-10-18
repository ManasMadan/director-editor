/**
 * Director Live's hooks, each on a test page: what the phone sees for itself (the light,
 * the shake, a take's log), what the object detector finds, what the recogniser hears,
 * what Director says, what it remembers, and the screen's own behaviour (the wake lock,
 * the buzz, the controls stepping back).
 */
import { HOUR_MS } from "@repo/contracts/time";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { useListening } from "@/modules/director/hooks/use-listening";
import { useLiveDirector } from "@/modules/director/hooks/use-live-director";
import { useMemory } from "@/modules/director/hooks/use-memory";
import { buzz, useIdle, useWakeLock } from "@/modules/director/hooks/use-screen";
import { useThings } from "@/modules/director/hooks/use-things";
import { useVision } from "@/modules/director/hooks/use-vision";
import type { Perception } from "@/modules/director/lib/cues";
import { FRESH } from "@/modules/director/lib/memory";
import { createThingDetector } from "@/modules/director/lib/object-detector";
import { saying } from "@/modules/director/lib/speech";
import { signUp } from "../users";
import {
  cameraStream,
  cameraVideo,
  canvasCamera,
  deferred,
  FakeRecognizer,
  fakeRecognizer,
  renderHook,
  shot,
  silentWav,
  standIn,
  until,
} from "./support";

vi.mock("@/modules/director/lib/object-detector", () => ({ createThingDetector: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A <video> showing the stand-in camera (a canvas that keeps changing colour). */
async function liveVideo() {
  canvasCamera();
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
  document.body.append(video);
  await video.play();
  await expect.poll(() => video.videoWidth).toBeGreaterThan(0);
  return video;
}

describe("useVision", () => {
  it("reads the light, the shake and a new place, and logs a take with the voice's level", async () => {
    const video = { current: await liveVideo() };
    // Sound starts only after the page has been interacted with.
    await userEvent.click(document.body);
    const audio = new AudioContext();
    await audio.resume();
    const stream = cameraStream();
    for (const track of audio.createMediaStreamDestination().stream.getAudioTracks()) {
      stream.addTrack(track);
    }
    let recording = false;
    const hook = await renderHook(() => useVision(video, stream, { active: true, recording }));
    await expect.poll(() => hook.current.moved).toBeGreaterThan(0);
    await expect.poll(() => hook.current.light).not.toBeNull();
    recording = true;
    hook.rerender();
    await expect.poll(() => hook.current.take().length).toBeGreaterThan(2);
    const [first] = hook.current.take();
    expect(first?.seconds).toBeGreaterThanOrEqual(0);
    expect(typeof first?.motion).toBe("number");
    await audio.close();
  });

  it("logs no voice for a take without sound, or while the browser holds the audio back", async () => {
    const video = { current: await liveVideo() };
    const audio = new AudioContext();
    const stream = cameraStream();
    for (const track of audio.createMediaStreamDestination().stream.getAudioTracks()) {
      stream.addTrack(track);
    }
    vi.spyOn(BaseAudioContext.prototype, "state", "get").mockReturnValue("suspended");
    const silent = await renderHook(() =>
      useVision(video, stream, { active: true, recording: true }),
    );
    await expect.poll(() => silent.current.take().length).toBeGreaterThan(1);
    expect(silent.current.take().every((sample) => sample.loudness === null)).toBe(true);
  });

  it("looks at nothing with no frame, no camera, or the page hidden, and nothing while inactive", async () => {
    const live = await liveVideo();
    // The looks on the test's clock: each `look()` is four of them, a second's worth.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const look = () => vi.advanceTimersByTime(1_000);
    const video: { current: HTMLVideoElement | null } = { current: null };
    const hook = await renderHook(() => useVision(video, null, { active: true, recording: false }));
    look();
    expect(hook.current.moved).toBe(0);
    video.current = cameraVideo({ readyState: 1 });
    look();
    expect(hook.current.moved).toBe(0);
    video.current = live;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    look();
    expect(hook.current.moved).toBe(0);
    hidden.mockRestore();
    look();
    await until(() => expect(hook.current.moved).toBeGreaterThan(0));
    const idle = await renderHook(() =>
      useVision(video, null, { active: false, recording: false }),
    );
    expect(idle.current.light).toBeNull();
  });
});

describe("useThings", () => {
  it("highlights what the detector finds, and closes a detector that loads too late", async () => {
    const plant = {
      thing: "plant" as const,
      role: "backdrop" as const,
      score: 0.9,
      box: { x: 0, y: 0, width: 0.3, height: 0.3 },
    };
    const close = vi.fn();
    vi.mocked(createThingDetector).mockResolvedValue({ detect: () => [plant], close });
    const video = { current: cameraVideo() };
    const hook = await renderHook(() => useThings(video, { enabled: true, landmark: "tree" }));
    await expect.poll(() => hook.current.map((seen) => seen.thing)).toEqual(["plant"]);
    hook.unmount();
    expect(close).toHaveBeenCalledOnce();

    const slow = deferred<Awaited<ReturnType<typeof createThingDetector>>>();
    vi.mocked(createThingDetector).mockReturnValue(slow.promise);
    const late = await renderHook(() => useThings(video, { enabled: true, landmark: null }));
    late.unmount();
    const lateClose = vi.fn();
    slow.resolve({ detect: () => [], close: lateClose });
    await expect.poll(() => lateClose.mock.calls.length).toBe(1);
  });

  it("highlights nothing when off, or when the detector can't load", async () => {
    vi.mocked(createThingDetector).mockRejectedValue(new Error("no GPU"));
    const video = { current: cameraVideo() };
    let enabled = true;
    const hook = await renderHook(() => useThings(video, { enabled, landmark: null }));
    await expect.poll(() => vi.mocked(createThingDetector).mock.calls.length).toBe(1);
    expect(hook.current).toEqual([]);
    enabled = false;
    hook.rerender();
    expect(hook.current).toEqual([]);
  });
});

describe("useListening", () => {
  it("hears phrases, lets the member interrupt, and ignores noise and Director's echo", async () => {
    fakeRecognizer();
    const onPhrase = vi.fn();
    const onInterrupt = vi.fn();
    const hook = await renderHook(() => useListening(true, "en-GB", { onPhrase, onInterrupt }));
    await expect.poll(() => hook.current.state).toBe("listening");
    const ears = FakeRecognizer.last as FakeRecognizer;
    expect([ears.lang, ears.continuous, ears.interimResults]).toEqual(["en-GB", true, true]);
    ears.hear("wait", { final: false });
    expect(onInterrupt).toHaveBeenCalledOnce();
    await expect.poll(() => hook.current.words).toBe("wait");
    ears.hear("action", { confidence: 0.1 });
    expect(onPhrase).not.toHaveBeenCalled();
    ears.hear("action");
    expect(onPhrase).toHaveBeenCalledWith("action", 0.9);
    hook.current.clear();
    await expect.poll(() => hook.current.words).toBe("");
  });

  it("hands a phrase heard right as the screen changes to the handlers of that screen", async () => {
    fakeRecognizer();
    const heardBy: number[] = [];
    let screen = 0;
    let spoken = false;
    const hook = await renderHook(() => {
      const mine = screen;
      const listening = useListening(true, "en", {
        onPhrase: () => heardBy.push(mine),
        onInterrupt: vi.fn(),
      });
      // The member speaks in the same moment the screen changes (a "go again" as the take's
      // review appears): before any effect after paint has run.
      useLayoutEffect(() => {
        if (mine > 0 && !spoken) {
          spoken = true;
          FakeRecognizer.last?.hear("go again");
        }
      });
      return listening;
    });
    await expect.poll(() => hook.current.state).toBe("listening");
    screen = 1;
    hook.rerender();
    expect(heardBy).toEqual([1]);
  });

  it("keeps listening through other errors, and says when the microphone is refused", async () => {
    fakeRecognizer();
    const hook = await renderHook(() =>
      useListening(true, "en", { onPhrase: vi.fn(), onInterrupt: vi.fn() }),
    );
    await expect.poll(() => hook.current.state).toBe("listening");
    const ears = FakeRecognizer.last as FakeRecognizer;
    ears.fail("no-speech");
    expect(hook.current.state).toBe("listening");
    ears.fail("service-not-allowed");
    await expect.poll(() => hook.current.state).toBe("blocked");
    // Refused: it doesn't start again on its own, however long it waits.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ears.stop();
    vi.advanceTimersByTime(10_000);
    expect(ears.started).toBe(1);
  });

  it("says when the browser has no recogniser, and is off when not wanted", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const none = await renderHook(() =>
      useListening(true, "en", { onPhrase: vi.fn(), onInterrupt: vi.fn() }),
    );
    await expect.poll(() => none.current.state).toBe("unsupported");
    fakeRecognizer();
    const off = await renderHook(() =>
      useListening(false, "en", { onPhrase: vi.fn(), onInterrupt: vi.fn() }),
    );
    expect(off.current.state).toBe("off");
  });
});

const quiet: Perception = {
  phase: "setup",
  paused: true,
  sharing: false,
  micRecording: false,
  countdown: null,
  countdownFrom: 3,
  scene: null,
  offline: false,
  light: null,
  framing: null,
  angle: null,
  posed: null,
  ready: false,
  things: [],
  step: null,
  ideas: [],
};

describe("useLiveDirector", () => {
  /** The API with Director's own voice off: lines are said in the browser's. */
  const voiceOff = () =>
    standIn((os) => ({
      director: {
        speak: os.director.speak.handler(({ errors }) => {
          throw errors.FEATURE_DISABLED({ data: { params: { feature: "files" } } });
        }),
      },
    }));

  it("welcomes the member back with what it remembers: the light, then a favourite prop", async () => {
    const speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    const said = () => speak.mock.calls.map(([utterance]) => utterance.text);
    const back = { ...FRESH, sessions: 3 };
    const dark = await renderHook(
      () =>
        useLiveDirector({
          perception: { ...quiet, paused: false },
          speak: true,
          memory: { ...back, light: { "too-dark": 3 } },
          shot: shot(),
          index: 0,
        }),
      { api: voiceOff() },
    );
    await expect
      .poll(said)
      .toContain(
        "Welcome back! Last time it was a little dark, so let's find a spot with nice light. The walk-in.",
      );
    dark.unmount();
    await renderHook(
      () =>
        useLiveDirector({
          perception: { ...quiet, paused: false },
          speak: true,
          memory: { ...back, things: { plant: 2 } },
          shot: shot(),
          index: 0,
        }),
      { api: voiceOff() },
    );
    await expect
      .poll(said)
      .toContain("Welcome back! Got your plant? It looked great last time. The walk-in.");
  });

  it("has nothing to repeat before it has said anything, and goes quiet when its voice is off", async () => {
    const cancel = vi.spyOn(window.speechSynthesis, "cancel").mockImplementation(() => undefined);
    let speak = true;
    const hook = await renderHook(
      () => useLiveDirector({ perception: quiet, speak, memory: FRESH, shot: shot(), index: 0 }),
      { api: voiceOff() },
    );
    hook.current.repeat();
    expect(hook.current.line).toBeNull();
    speak = false;
    hook.rerender();
    expect(cancel).toHaveBeenCalled();
    // With the voice off, a call is still written, just not said.
    const speakLine = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    hook.current.announce("Cut!");
    hook.rerender();
    expect(hook.current.line?.text).toBe("Cut!");
    expect(speakLine).not.toHaveBeenCalled();
  });

  /** Director on set, its voice on, with `director.speak` speaking each line or failing. */
  async function onSet(speech: "spoken" | "failing") {
    const browser = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    const asked: string[] = [];
    const api = standIn((os) => ({
      director: {
        speak: os.director.speak.handler(({ input, errors }) => {
          asked.push(input.text);
          if (speech === "failing") {
            throw errors.UPSTREAM_UNAVAILABLE({ data: { params: {} } });
          }
          return { url: silentWav(1), expiresAt: new Date(Date.now() + HOUR_MS) };
        }),
      },
    }));
    const hook = await renderHook(
      () =>
        useLiveDirector({ perception: quiet, speak: true, memory: FRESH, shot: shot(), index: 0 }),
      { api },
    );
    const saidByBrowser = () => browser.mock.calls.map(([utterance]) => utterance.text);
    return { hook, asked, saidByBrowser };
  }

  it("says its lines in its own voice (Gemini's), not the browser's", async () => {
    // The browser plays sound once the member has touched the page.
    await userEvent.click(document.body);
    const { hook, asked, saidByBrowser } = await onSet("spoken");
    hook.current.announce("Cut!");
    await expect.poll(saying).toBe("Cut!");
    expect(asked).toContain("Cut!");
    expect(saidByBrowser()).not.toContain("Cut!");
  });

  it("says its lines in the browser's voice when its own can't be had", async () => {
    const { hook, asked, saidByBrowser } = await onSet("failing");
    hook.current.announce("Cut!");
    await expect.poll(saidByBrowser).toContain("Cut!");
    expect(asked).toContain("Cut!");
  });
});

describe("useMemory", () => {
  it("remembers nothing until the member is known, then keeps their own", async () => {
    const signedOut = await renderHook(() => useMemory());
    expect(signedOut.current.memory).toBe(FRESH);
    signedOut.current.record({ type: "opened" });
    await expect.poll(() => signedOut.current.memory.sessions).toBe(1);
    signedOut.unmount();

    const user = await signUp();
    window.localStorage.setItem(
      `director.memory.${user.id}`,
      JSON.stringify({ ...FRESH, sessions: 4 }),
    );
    const mine = await renderHook(() => useMemory());
    await expect.poll(() => mine.current.before.sessions).toBe(4);
    mine.current.record({ type: "prefer", speak: false });
    await expect.poll(() => mine.current.memory.speak).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem(`director.memory.${user.id}`) ?? "{}"),
    ).toMatchObject({ speak: false, sessions: 4 });
  });
});

describe("the screen", () => {
  it("keeps the screen awake, takes the lock again on return, and lets it go", async () => {
    const release = vi.fn(async () => undefined);
    const request = vi
      .spyOn(navigator.wakeLock, "request")
      .mockResolvedValue({ release } as unknown as WakeLockSentinel);
    const hook = await renderHook(() => useWakeLock());
    await expect.poll(() => request.mock.calls.length).toBe(1);
    // Hidden: nothing to take; visible again: taken again.
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(request).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await expect.poll(() => request.mock.calls.length).toBe(2);
    hook.unmount();
    await expect.poll(() => release.mock.calls.length).toBe(1);
  });

  it("copes with a refused lock, and a browser without one", async () => {
    const request = vi
      .spyOn(navigator.wakeLock, "request")
      .mockRejectedValue(new DOMException("battery saver", "NotAllowedError"));
    const refused = await renderHook(() => useWakeLock());
    await expect.poll(() => request.mock.calls.length).toBe(1);
    refused.unmount();
    const wakeLock = Object.getOwnPropertyDescriptor(Navigator.prototype, "wakeLock");
    Reflect.deleteProperty(Navigator.prototype, "wakeLock");
    try {
      const none = await renderHook(() => useWakeLock());
      none.unmount();
    } finally {
      if (wakeLock) {
        Object.defineProperty(Navigator.prototype, "wakeLock", wakeLock);
      }
    }
  });

  it("buzzes where the phone can, and does nothing where it can't", () => {
    const vibrate = vi.spyOn(navigator, "vibrate").mockReturnValue(true);
    buzz(30);
    expect(vibrate).toHaveBeenCalledWith(30);
    vibrate.mockRestore();
    const own = Object.getOwnPropertyDescriptor(Navigator.prototype, "vibrate");
    Reflect.deleteProperty(Navigator.prototype, "vibrate");
    try {
      expect(() => buzz([10, 20])).not.toThrow();
    } finally {
      if (own) {
        Object.defineProperty(Navigator.prototype, "vibrate", own);
      }
    }
  });

  it("steps the controls back when left alone, and brings them back on a touch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let enabled = true;
    const hook = await renderHook(() => useIdle(enabled));
    vi.advanceTimersByTime(4_000);
    hook.rerender();
    expect(hook.current).toBe(true);
    window.dispatchEvent(new PointerEvent("pointermove"));
    hook.rerender();
    expect(hook.current).toBe(false);
    enabled = false;
    hook.rerender();
    vi.advanceTimersByTime(10_000);
    hook.rerender();
    expect(hook.current).toBe(false);
  });
});
