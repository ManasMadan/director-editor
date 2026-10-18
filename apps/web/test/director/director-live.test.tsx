/**
 * Director live as the shoot screen runs it, against a stand-in for the API's relay: the
 * microphone (16 kHz PCM from the AudioWorklet) and a frame a second go up; Director's
 * voice plays, both sides are captioned, its tool calls are answered with what really
 * happened; and when the line goes, it comes back once by itself before the member is
 * told. The relay is a stand-in socket the test speaks for; the camera and microphone
 * are a canvas and a tone; the audio graph, the worklet and the API are the browser's
 * and the app's own.
 */
import { useSearchParams } from "next/navigation";
import { Activity, type ReactNode, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { DirectorOrb } from "@/modules/director/components/director-captions";
import { useDirectorLive } from "@/modules/director/hooks/use-director-live";
import { cleanup, currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import {
  cameraVideo,
  canvasCamera,
  deferred,
  newVideoId,
  planShot,
  readyPlan,
  renderHook,
  shotPlan,
} from "./support";

type Sent = { type: string; pcm16?: string; jpeg?: string; [key: string]: unknown };

/**
 * The relay, as the page's WebSocket: the page's side (what it sent, `close`) and the
 * relay's (`open`, `say`, `hangUp`), which the test plays.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Sent[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  static get last() {
    return FakeSocket.all.at(-1) as FakeSocket;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close() {
    if (this.readyState !== FakeSocket.CLOSED) {
      this.readyState = FakeSocket.CLOSED;
      queueMicrotask(() => this.onclose?.(new CloseEvent("close", { code: 1000 })));
    }
  }
  sentOf(type: string) {
    return this.sent.filter((message) => message.type === type);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  say(message: object | string) {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  /** The relay hangs up: with an error code first, as it does, or without a word. */
  hangUp(code?: string) {
    if (code) {
      this.say({ type: "error", code });
    }
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: code ? 1011 : 1006 }));
  }
}

/** `seconds` of a tone as base64 24 kHz PCM, as Director's voice arrives. */
function voice(seconds: number) {
  const samples = Math.round(24_000 * seconds);
  const bytes = new DataView(new ArrayBuffer(samples * 2));
  for (let at = 0; at < samples; at += 1) {
    bytes.setInt16(at * 2, Math.round(Math.sin((2 * Math.PI * 220 * at) / 24_000) * 12_000), true);
  }
  let binary = "";
  for (const byte of new Uint8Array(bytes.buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const walk = planShot({ title: "Walk", durationSeconds: 5 });
const smile = planShot({ kind: "photo", title: "Smile", durationSeconds: 1, scene: "Kitchen" });

/** The shoot route as Next serves it: the shot from the address, the page kept mounted. */
function ShootRoute({ videoId }: { videoId: string }) {
  const query = useSearchParams();
  return (
    <ShootPage
      videoId={videoId}
      shot={query.get("shot") ?? undefined}
      audio={query.get("audio") ?? undefined}
    />
  );
}

/**
 * A screen whose effects the test can tear down and set up again, keeping its state
 * (`remount`): hiding an Activity does that, as Strict Mode's second mount and Fast
 * Refresh do.
 */
const screen = { remount: (_visible: boolean): void => undefined };
function Remountable({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);
  screen.remount = (next) => flushSync(() => setVisible(next));
  return <Activity mode={visible ? "visible" : "hidden"}>{children}</Activity>;
}

type Page = Awaited<ReturnType<typeof renderPage>>;

/** The shoot screen for a short, Start shooting tapped, and the relay picking up. */
async function shoot(audio: "original" | "voice" = "voice") {
  const videoId = newVideoId();
  await readyPlan(
    videoId,
    shotPlan({ audio: audio === "voice" ? "speech" : "music", shots: [walk, smile] }),
  );
  await signUp();
  const page = await renderPage(
    <Remountable>
      <ShootRoute videoId={videoId} />
    </Remountable>,
    { url: `/director/${videoId}/shoot?shot=0&audio=${audio}` },
  );
  await userEvent.click(page.getByRole("button", { name: "Start shooting" }));
  await expect.poll(() => FakeSocket.all.length).toBe(1);
  const socket = FakeSocket.last;
  socket.open();
  await expect.element(page.getByText("Director", { exact: true })).toBeVisible();
  return { page, videoId, socket };
}

/** Director's own microphone: the last stream asked for with sound and no picture. */
function microphoneOf(camera: ReturnType<typeof canvasCamera>): Promise<MediaStream> {
  const at = camera.opened.findLastIndex((constraints) => !constraints.video);
  return camera.getUserMedia.mock.results[at]?.value;
}

/** The captions on screen, oldest first. */
const captionTexts = () =>
  [...document.querySelectorAll("[aria-hidden] > div > p, [aria-hidden] > p")].map((line) =>
    (line.textContent ?? "").trim(),
  );

/** Whether Director's voice is playing: the orb in the captions swells with it. */
const speakingNow = (page: Page) =>
  page.getByRole("button", { name: "Record a take" }).query() !== null;

describe("Director live on the shoot screen", () => {
  it("hears and sees the member, speaks, and captions both sides, typed lines too", async () => {
    const camera = canvasCamera();
    const { page, videoId, socket } = await shoot();
    expect(socket.url).toBe(`ws://${window.location.host}/api/live?videoId=${videoId}&shot=0`);
    // Its own microphone, with the browser's clean-up.
    expect(camera.opened).toContainEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // The microphone goes up as ~100 ms of 16 kHz PCM at a time, and a frame each second.
    await expect.poll(() => socket.sentOf("audio").length, { timeout: 10_000 }).toBeGreaterThan(2);
    const chunk = atob(socket.sentOf("audio")[1]?.pcm16 ?? "");
    expect(chunk.length).toBeGreaterThanOrEqual(3000);
    expect(chunk.length).toBeLessThanOrEqual(3300);
    await expect.poll(() => socket.sentOf("frame").length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(atob(socket.sentOf("frame")[0]?.jpeg ?? "").slice(0, 3)).toBe("\xff\xd8\xff");

    socket.say({ type: "audio", pcm16: voice(0.4) });
    socket.say({ type: "transcript", who: "director", text: "Hi! " });
    socket.say({ type: "transcript", who: "director", text: "Step back a little." });
    socket.say({ type: "transcript", who: "you", text: "Like this?" });
    await expect.element(page.getByText(/^Hi! Step back a little\.$/)).toBeVisible();
    await expect.element(page.getByText(/^Like this\?$/)).toBeVisible();
    // A finished line is read out once, whole: Director's, now the member has spoken.
    await expect
      .element(page.getByText(/^Director says Hi! Step back a little\.$/))
      .toBeInTheDocument();
    // Director's answer goes under the line it answers, the newest at the bottom.
    socket.say({ type: "transcript", who: "director", text: "Perfect." });
    await expect.element(page.getByText(/^Perfect\.$/)).toBeVisible();
    expect(captionTexts()).toEqual(["Like this?", "Perfect."]);
    socket.say({ type: "turn" });
    await expect.element(page.getByText(/^Director says Perfect\.$/)).toBeInTheDocument();
    // Its next turn is a line of its own.
    socket.say({ type: "transcript", who: "director", text: "Now walk in." });
    await expect.poll(captionTexts).toEqual(["Perfect.", "Now walk in."]);

    await userEvent.fill(page.getByRole("textbox", { name: "Tell Director" }), "  hello there ");
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    expect(socket.sentOf("text")).toEqual([{ type: "text", text: "hello there" }]);
    // A typed line is the member's own new line, under the rest.
    await expect.poll(captionTexts).toEqual(["Now walk in.", "hello there"]);
    await expect.element(page.getByText(/^You said hello there$/)).toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Tell Director" })).toHaveValue("");
    // Nothing to send, nothing sent.
    await userEvent.fill(page.getByRole("textbox", { name: "Tell Director" }), "   ");
    await userEvent.keyboard("{Enter}");
    expect(socket.sentOf("text")).toHaveLength(1);
    expect(speakingNow(page)).toBe(true);
  });

  it("answers Director's tool calls with what really happened", async () => {
    canvasCamera();
    const { page, videoId, socket } = await shoot();
    socket.say({ type: "tool", id: "t1", call: { name: "go_to_shot", shot: 1 } });
    await expect.poll(currentUrl).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
    await expect.poll(() => socket.sentOf("shot")).toEqual([{ type: "shot", shot: 1 }]);
    // Asking for the shot it's on already is fine, and changes nothing.
    socket.say({ type: "tool", id: "t2", call: { name: "go_to_shot", shot: 1 } });
    socket.say({ type: "tool", id: "t3", call: { name: "switch_camera", to: "back" } });
    await expect
      .poll(() => socket.sentOf("tool_result"))
      .toEqual([
        { type: "tool_result", id: "t1", result: "done" },
        { type: "tool_result", id: "t2", result: "done" },
        { type: "tool_result", id: "t3", result: "done" },
      ]);
    // Mid-take, nothing moves: Director hears it's busy.
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    await expect.element(page.getByRole("button", { name: "Cancel the countdown" })).toBeVisible();
    socket.say({ type: "tool", id: "t4", call: { name: "go_to_shot", shot: 0 } });
    await expect
      .poll(() => socket.sentOf("tool_result").at(-1))
      .toEqual({ type: "tool_result", id: "t4", result: "busy" });
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=1&audio=voice`);
  });

  it("says when the camera's off and can't be switched", async () => {
    const camera = canvasCamera();
    const { socket, page } = await shoot();
    // The camera is refused after a flip: it's off now.
    camera.getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await userEvent.click(page.getByRole("button", { name: "Flip the camera" }));
    await expect.element(page.getByText("Let's get the camera on")).toBeVisible();
    socket.say({ type: "tool", id: "t1", call: { name: "switch_camera", to: "front" } });
    await expect
      .poll(() => socket.sentOf("tool_result"))
      .toEqual([{ type: "tool_result", id: "t1", result: "no_camera" }]);
  });

  it("tells Director about a flip once the other camera shows a picture", async () => {
    canvasCamera();
    const { page, socket } = await shoot();
    await expect.poll(() => socket.sentOf("frame").length, { timeout: 5_000 }).toBeGreaterThan(0);
    await userEvent.click(page.getByRole("button", { name: "Flip the camera" }));
    await expect
      .poll(() => socket.sentOf("camera"), { timeout: 5_000 })
      .toEqual([{ type: "camera", facing: "back" }]);
    // A frame of the new view goes just before the note.
    const at = socket.sent.findIndex((message) => message.type === "camera");
    expect(socket.sent[at - 1]?.type).toBe("frame");
  });

  it("keeps Director quiet from the 3-2-1 to the take's end, and tells it where the take is", async () => {
    canvasCamera();
    const { page, socket } = await shoot();
    socket.say({ type: "audio", pcm16: voice(10) });
    socket.say({ type: "transcript", who: "you", text: "Ready." });
    await expect.element(page.getByText(/^Ready\.$/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    // Quiet from the first number, and the member's line has had its moment.
    expect(socket.sentOf("take")).toEqual([{ type: "take", state: "countdown" }]);
    await expect.poll(captionTexts).toEqual([]);
    // What Director says while held is neither played nor shown, then or after.
    socket.say({ type: "transcript", who: "director", text: "Three, two..." });
    await expect.element(page.getByText("REC"), { timeout: 6_000 }).toBeVisible();
    socket.say({ type: "audio", pcm16: voice(1) });
    socket.say({ type: "transcript", who: "director", text: "Shh." });
    // Director speaks the moment the take shows, before anything else has run: it's heard.
    const reviewed = new MutationObserver(() => {
      if (document.querySelector('[aria-label="Your take, on loop"]')) {
        reviewed.disconnect();
        socket.say({ type: "transcript", who: "director", text: "Lovely." });
      }
    });
    reviewed.observe(document.body, { childList: true, subtree: true });
    await userEvent.click(page.getByRole("button", { name: "Stop recording" }));
    await expect.element(page.getByLabelText("Your take, on loop")).toBeVisible();
    await expect.poll(captionTexts).toEqual(["Lovely."]);
    await userEvent.click(page.getByRole("button", { name: "Go again" }));
    // A countdown called off is told too.
    await userEvent.click(page.getByRole("button", { name: "Record a take" }));
    await userEvent.click(page.getByRole("button", { name: "Cancel the countdown" }));
    expect(socket.sentOf("take")).toEqual([
      { type: "take", state: "countdown" },
      { type: "take", state: "recording" },
      { type: "take", state: "recorded" },
      { type: "take", state: "discarded" },
      { type: "take", state: "countdown" },
      { type: "take", state: "cancelled" },
    ]);
  });

  it("lets the member's line go after a flip, and a while after Director has answered it", async () => {
    canvasCamera();
    const { page, socket } = await shoot();
    socket.say({ type: "transcript", who: "you", text: "Can you see me?" });
    await expect.element(page.getByText(/^Can you see me\?$/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Flip the camera" }));
    await expect.poll(captionTexts).toEqual([]);
    socket.say({ type: "transcript", who: "you", text: "And now?" });
    socket.say({ type: "transcript", who: "director", text: "Yes!" });
    await expect.poll(captionTexts).toEqual(["And now?", "Yes!"]);
    socket.say({ type: "turn" });
    // Eight seconds after the answer, only the answer stays.
    await expect.poll(captionTexts, { timeout: 12_000 }).toEqual(["Yes!"]);
  });

  it("drops Director's voice the moment the member talks over it, and ignores what it can't read", async () => {
    canvasCamera();
    const { page, socket } = await shoot();
    socket.say({ type: "audio", pcm16: voice(5) });
    socket.say({ type: "interrupted" });
    socket.say("not json");
    socket.say({ type: "audio", pcm16: "" });
    socket.say({ type: "tool", id: "x", call: { name: "start_recording" } });
    expect(socket.sentOf("tool_result")).toEqual([]);
    await expect.element(page.getByText("Director", { exact: true })).toBeVisible();
  });

  it("comes back by itself once when the line drops, then says why if it can't", async () => {
    canvasCamera();
    const { page, videoId, socket } = await shoot();
    socket.hangUp();
    // One silent try, picking the conversation up rather than saying hello again.
    await expect.poll(() => FakeSocket.all.length, { timeout: 5_000 }).toBe(2);
    expect(FakeSocket.last.url).toBe(
      `ws://${window.location.host}/api/live?videoId=${videoId}&shot=0&resume=1`,
    );
    expect(page.getByRole("status").getByText("Director lost the connection.").query()).toBeNull();
    FakeSocket.last.open();
    await expect.element(page.getByText("Director", { exact: true })).toBeVisible();
    // Back, so the next drop gets its own silent try too; this time it fails again.
    FakeSocket.last.hangUp("UPSTREAM_UNAVAILABLE");
    await expect.poll(() => FakeSocket.all.length, { timeout: 5_000 }).toBe(3);
    FakeSocket.last.hangUp("UPSTREAM_UNAVAILABLE");
    await expect.element(page.getByText("Director can't reach Gemini right now.")).toBeVisible();
    await expect
      .element(page.getByText("You can still film: tap the shutter for each take."))
      .toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Tell Director" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Record a take" })).toBeEnabled();
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect.poll(() => FakeSocket.all.length).toBe(4);
    expect(FakeSocket.last.url).not.toContain("resume");
  });

  it("says why in its own words, or the API's when it has none", async () => {
    canvasCamera();
    const { page } = await shoot();
    const cases: [string, string][] = [
      ["RATE_LIMITED", "Director has joined you a lot this hour. Give it a little while."],
      ["TIMEOUT", "That's half an hour with Director, the most in one go."],
      ["NO_ACTIVE_ORGANIZATION", "Choose a workspace first."],
    ];
    for (const [code, message] of cases) {
      FakeSocket.last.hangUp(code);
      await expect.element(page.getByText(message)).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Try again" }));
      await expect.poll(() => FakeSocket.last.readyState).toBe(FakeSocket.CONNECTING);
      FakeSocket.last.open();
    }
  });

  it("carries on without the microphone: Director sees, speaks and reads", async () => {
    const camera = canvasCamera();
    // The camera opens; Director's own microphone is refused.
    camera.getUserMedia.mockImplementation(async (constraints = {}) => {
      if (!constraints.video) {
        throw new DOMException("denied", "NotAllowedError");
      }
      return document.createElement("canvas").captureStream();
    });
    const { page, socket } = await shoot("original");
    await expect
      .element(page.getByText(/Director can't hear you\. Allow the microphone/))
      .toBeVisible();
    await expect.poll(() => socket.sentOf("frame").length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(socket.sentOf("audio")).toEqual([]);
  });

  it("goes deaf, not away, when the microphone goes mid-shoot", async () => {
    const camera = canvasCamera();
    const { page, socket } = await shoot("original");
    const microphone = await microphoneOf(camera);
    microphone.getAudioTracks()[0]?.dispatchEvent(new Event("ended"));
    await expect
      .element(page.getByText(/Director can't hear you\. Allow the microphone/))
      .toBeVisible();
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(microphone.getAudioTracks()[0]?.readyState).toBe("ended");
  });

  it("comes back by itself, without a second hello, when the screen is remounted", async () => {
    canvasCamera();
    const { page, socket } = await shoot();
    screen.remount(false);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    screen.remount(true);
    await expect.poll(() => FakeSocket.all.length).toBe(2);
    expect(FakeSocket.last.url).toContain("resume=1");
    FakeSocket.last.open();
    await expect.element(page.getByText("Director", { exact: true })).toBeVisible();
  });
});

describe("Director live's hook", () => {
  const options = (shotIndex = 0) => ({
    videoId: "abcdefghijk",
    shotIndex,
    video: { current: cameraVideo() },
    onTool: vi.fn(),
  });

  it("does nothing before Director is there", async () => {
    const hook = await renderHook(() => useDirectorLive(options()));
    expect(hook.current.say("hi")).toBe(false);
    hook.current.answer("t1", "done");
    hook.current.take("recording");
    hook.current.camera("back");
    hook.current.hold(true);
    expect(hook.current.level()).toBe(0);
    expect(hook.current.state).toBe("idle");
  });

  it("tells Director about a flip at once when the picture's already up, and not after it's gone", async () => {
    canvasCamera();
    const hook = await renderHook(() => useDirectorLive(options()));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    // Still joining: nothing to tell yet.
    hook.current.camera("back");
    hook.current.answer("t0", "done");
    hook.current.take("countdown");
    FakeSocket.last.open();
    // The camera's <video> already shows a picture: the note goes straight after a frame.
    hook.current.camera("front");
    await expect
      .poll(() => FakeSocket.last.sentOf("camera"), { timeout: 5_000 })
      .toEqual([{ type: "camera", facing: "front" }]);
    expect(FakeSocket.last.sentOf("tool_result")).toEqual([]);
    expect(FakeSocket.last.sentOf("take")).toEqual([]);
    // Flipped, then gone before the frame could go: nothing more is sent on the old line.
    hook.current.camera("back");
    FakeSocket.last.hangUp("RATE_LIMITED");
    await expect.poll(() => hook.current.state).toBe("unavailable");
    expect(FakeSocket.last.sentOf("camera")).toHaveLength(1);
  });

  it("tells the relay about a move to another shot made while it was still joining", async () => {
    canvasCamera();
    const events = options();
    const hook = await renderHook(() => useDirectorLive(events));
    await userEvent.click(document.body);
    hook.current.start();
    // A second tap while it's joining is the same connection.
    hook.current.start();
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    events.shotIndex = 1;
    hook.rerender();
    FakeSocket.last.open();
    await expect.poll(() => FakeSocket.last.sentOf("shot")).toEqual([{ type: "shot", shot: 1 }]);
    events.shotIndex = 0;
    hook.rerender();
    hook.rerender();
    await expect.poll(() => FakeSocket.last.sentOf("shot")).toHaveLength(2);
  });

  it("lets the microphone go when the screen goes while the browser still asks for it", async () => {
    const asked = deferred<MediaStream>();
    const camera = canvasCamera();
    camera.getUserMedia.mockReturnValueOnce(asked.promise);
    const hook = await renderHook(() => useDirectorLive(options()));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => camera.getUserMedia.mock.calls.length).toBe(1);
    await hook.unmount();
    const stream = new AudioContext().createMediaStreamDestination().stream;
    asked.resolve(stream);
    await expect.poll(() => stream.getTracks()[0]?.readyState).toBe("ended");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("goes without a microphone when the one it gets has no sound in it", async () => {
    const camera = canvasCamera();
    camera.getUserMedia.mockImplementationOnce(async () =>
      document.createElement("canvas").captureStream(),
    );
    const hook = await renderHook(() => useDirectorLive(options()));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => hook.current.hearing).toBe(false);
    const stream: MediaStream = await camera.getUserMedia.mock.results[0]?.value;
    expect(stream.getTracks()[0]?.readyState).toBe("ended");
    await expect.poll(() => FakeSocket.all.length).toBe(1);
  });

  it("lets go quietly when the screen goes, stops the worklet, and skips a frame it can't take", async () => {
    canvasCamera();
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    const hook = await renderHook(() => useDirectorLive(options()));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    const socket = FakeSocket.last;
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementationOnce((callback) => callback(null));
    socket.open();
    await expect.poll(() => toBlob.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(1);
    await expect.poll(() => socket.sentOf("frame").length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(hook.current.level()).toBeGreaterThanOrEqual(0);
    await hook.unmount();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(posted).toHaveBeenCalledWith("stop");
  });
});

describe("Director's orb", () => {
  it("holds still for anyone who prefers less motion", async () => {
    const real = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query.includes("reduced-motion") ? ({ matches: true } as MediaQueryList) : real(query),
    );
    const level = vi.fn(() => 1);
    await renderPage(<DirectorOrb level={level} className="size-6" />);
    await cleanup();
    expect(level).not.toHaveBeenCalled();
  });
});
