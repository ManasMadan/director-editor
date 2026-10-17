/**
 * The video call with Director: the camera screen rings Director over the API's live
 * relay, sends the microphone (16 kHz PCM from the AudioWorklet) and a frame a second,
 * plays Director's voice and captions both sides, and lets Director's tool calls drive
 * the recorder and the shots. When the call can't go on (no microphone, a dropped line,
 * an error from the relay) the shot carries on in Director Live, takes and all.
 *
 * The relay is a stand-in socket the test speaks for (real Vertex can't be reached
 * here); the camera and microphone are a canvas and a tone; the audio graph, the worklet,
 * the recorder and the API are the browser's and the app's own.
 */
import { useSearchParams } from "next/navigation";
import { Activity, type ReactNode, StrictMode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { CallOrb } from "@/modules/director/components/live-call";
import { useLiveCall } from "@/modules/director/hooks/use-live-call";
import { createThingDetector } from "@/modules/director/lib/object-detector";
import { createPoseDetector } from "@/modules/director/lib/pose-detector";
import { cleanup, currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import {
  cameraVideo,
  canvasCamera,
  deferred,
  FakeRecognizer,
  fakeRecognizer,
  newVideoId,
  planShot,
  readyPlan,
  renderHook,
  shotPlan,
  touch,
} from "./support";

vi.mock("@/modules/director/lib/pose-detector", () => ({ createPoseDetector: vi.fn() }));
vi.mock("@/modules/director/lib/object-detector", () => ({ createThingDetector: vi.fn() }));

type Sent = { type: string; pcm16?: string; jpeg?: string };

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
  vi.mocked(createPoseDetector).mockRejectedValue(new Error("offline"));
  vi.mocked(createThingDetector).mockRejectedValue(new Error("offline"));
  fakeRecognizer();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pour = planShot({ title: "Pour", durationSeconds: 5 });
const smile = planShot({ kind: "photo", title: "Smile", durationSeconds: 1, scene: "Kitchen" });

/**
 * The shoot route as Next serves it: the page reads the shot from the address, and stays
 * mounted (its state with it) when only the query changes.
 */
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

/** The camera screen for a short; by default filmed along to its original (no mic in takes). */
async function openShoot(audio: "original" | "voice" = "original") {
  const videoId = newVideoId();
  await readyPlan(
    videoId,
    shotPlan({ audio: audio === "voice" ? "speech" : "music", shots: [pour, smile] }),
  );
  const user = await signUp();
  const page = await renderPage(
    <Remountable>
      <ShootRoute videoId={videoId} />
    </Remountable>,
    { url: `/director/${videoId}/shoot?shot=0&audio=${audio}` },
  );
  return { page, videoId, user };
}

type Page = Awaited<ReturnType<typeof renderPage>>;

/** Rings Director, and the relay picks up. */
async function call(page: Page) {
  touch();
  await userEvent.click(page.getByRole("button", { name: "Call Director" }));
  await expect.poll(() => FakeSocket.all.length).toBeGreaterThan(0);
  const socket = FakeSocket.last;
  socket.open();
  await expect.element(page.getByText("On a call")).toBeVisible();
  return socket;
}

/** Whether the page is back on Director Live's own dock. */
const onDirectorLive = (page: Page) =>
  expect.element(page.getByRole("navigation", { name: "Camera controls" })).toBeVisible();

/** The call's own microphone: the last stream asked for with sound and no picture. */
function microphoneOf(camera: ReturnType<typeof canvasCamera>): Promise<MediaStream> {
  const at = camera.opened.findLastIndex((constraints) => !constraints.video);
  return camera.getUserMedia.mock.results[at]?.value;
}

const playing = () => document.querySelector(".opacity-90");
const focused = () => document.activeElement?.getAttribute("aria-label");

describe("a call with Director", () => {
  it("rings, hears and sees the member, speaks, captions both sides, mutes and hangs up", async () => {
    const speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    const camera = canvasCamera();
    const { page, videoId } = await openShoot();
    await expect.poll(() => FakeRecognizer.last?.started).toBe(1);

    touch();
    await userEvent.click(page.getByRole("button", { name: "Call Director" }));
    // Said once, by the loader; the words beside it are for the eye.
    await expect.element(page.getByRole("status", { name: "Calling Director…" })).toBeVisible();
    expect(page.getByText("Calling Director…").element().getAttribute("aria-hidden")).toBe("true");
    // The dock changed under the member's finger: focus goes to the call's own controls.
    await expect.poll(focused).toBe("End the call");
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    const socket = FakeSocket.last;
    expect(socket.url).toBe(`ws://${window.location.host}/api/live?videoId=${videoId}&shot=0`);
    // The microphone, opened for the call with the browser's clean-up.
    expect(camera.opened.at(-1)).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // On the call Gemini listens: the on-device ears stop.
    await expect.poll(() => FakeRecognizer.last?.aborted).toBe(true);
    // The mute waits for the line to be open.
    await expect.element(page.getByRole("button", { name: "Mute your microphone" })).toBeDisabled();

    socket.open();
    // Reaching Director is announced.
    await expect.element(page.getByText("On a call")).toBeVisible();
    expect(page.getByText("On a call").element().closest("[aria-live]")).not.toBeNull();
    // The microphone goes up as ~100 ms of 16 kHz PCM at a time, and a frame each second.
    await expect.poll(() => socket.sentOf("audio").length, { timeout: 10_000 }).toBeGreaterThan(2);
    const chunk = atob(socket.sentOf("audio")[1]?.pcm16 ?? "");
    expect(chunk.length).toBeGreaterThanOrEqual(3000);
    expect(chunk.length).toBeLessThanOrEqual(3300);
    await expect.poll(() => socket.sentOf("frame").length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(atob(socket.sentOf("frame")[0]?.jpeg ?? "").slice(0, 3)).toBe("\xff\xd8\xff");

    // Director speaks: its voice plays (the viewport glows) and both sides are captioned.
    socket.say({ type: "audio", pcm16: voice(0.6) });
    socket.say({ type: "audio", pcm16: voice(0.2) });
    await expect.poll(playing).not.toBeNull();
    socket.say({ type: "transcript", who: "director", text: "Hi! " });
    socket.say({ type: "transcript", who: "director", text: "Step back a little." });
    socket.say({ type: "transcript", who: "you", text: "Like this?" });
    await expect.element(page.getByText(/^Director says Hi! Step back a little\.$/)).toBeVisible();
    await expect.element(page.getByText(/^You said Like this\?$/)).toBeVisible();
    // It stops once it's said everything.
    await expect.poll(playing, { timeout: 5_000 }).toBeNull();
    // Gemini is the only voice: the on-device director stays quiet once the call is up.
    const said = speak.mock.calls.length;

    await userEvent.click(page.getByRole("button", { name: "Mute your microphone" }));
    await expect
      .element(page.getByRole("button", { name: "Unmute your microphone" }))
      .toHaveAttribute("aria-pressed", "true");
    const microphone = await microphoneOf(camera);
    expect(microphone.getAudioTracks().map((track) => track.enabled)).toEqual([false]);
    await userEvent.click(page.getByRole("button", { name: "Unmute your microphone" }));
    expect(microphone.getAudioTracks()[0]?.enabled).toBe(true);

    await userEvent.click(page.getByRole("button", { name: "End the call" }));
    await onDirectorLive(page);
    await expect.poll(focused).toBe("Call Director");
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(microphone.getAudioTracks()[0]?.readyState).toBe("ended");
    expect(page.getByRole("alert").query()).toBeNull();
    expect(speak.mock.calls.length).toBe(said);
    // Director Live listens again.
    await expect.poll(() => FakeRecognizer.last?.started).toBe(1);
    expect(FakeRecognizer.last?.aborted).toBe(false);
  });

  it("carries one call through the shots while Director records, stops and retakes", async () => {
    const camera = canvasCamera();
    const { page, videoId } = await openShoot();
    const socket = await call(page);
    await userEvent.click(page.getByRole("button", { name: "Mute your microphone" }));
    const here = `/director/${videoId}/shoot?shot=0&audio=original`;

    socket.say({ type: "tool", name: "start_recording", args: { reason: "ready" } });
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    // Captions stay up over the take's own foot.
    socket.say({ type: "transcript", who: "director", text: "Rolling, keep going." });
    await expect.element(page.getByText(/Rolling, keep going\./)).toBeVisible();
    // Going back, or moving on, mid-take would lose the take: neither happens.
    socket.say({ type: "tool", name: "previous_shot", args: {} });
    socket.say({ type: "tool", name: "next_shot", args: {} });
    socket.say({ type: "tool", name: "stop_recording", args: {} });
    await expect.element(page.getByText("Director's cut")).toBeVisible();
    expect(currentUrl()).toBe(here);

    // In the review: the call's captions above it, and mute and hang-up still to hand.
    socket.say({ type: "transcript", who: "director", text: "Lovely take." });
    await expect.element(page.getByText(/Lovely take\./)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "End the call" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Unmute your microphone" }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Record" }).query()).toBeNull();
    // Going back from the review would drop the unsent take.
    socket.say({ type: "tool", name: "previous_shot", args: {} });
    // Twice in a row, before the screen has caught up, is still one retake.
    socket.say({ type: "tool", name: "retake", args: {} });
    socket.say({ type: "tool", name: "retake", args: {} });
    await expect.element(page.getByRole("button", { name: "Record" })).toBeEnabled();
    await expect.element(page.getByText("Take 2 • Medium shot")).toBeVisible();
    expect(currentUrl()).toBe(here);
    // Going back from the first shot goes nowhere.
    socket.say({ type: "tool", name: "previous_shot", args: {} });
    expect(currentUrl()).toBe(here);

    // Before a take, moving on skips the shot: the same call is told, and stays muted.
    socket.say({ type: "tool", name: "next_shot", args: {} });
    await expect.poll(() => currentUrl()).toBe(`/director/${videoId}/shoot?shot=1&audio=original`);
    await expect.element(page.getByRole("img", { name: "Shot 2 of 2" })).toBeVisible();
    await expect.poll(() => socket.sentOf("shot")).toEqual([{ type: "shot", shot: 1 }]);
    expect(FakeSocket.all).toHaveLength(1);
    await expect.element(page.getByText("On a call")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Unmute your microphone" }))
      .toHaveAttribute("aria-pressed", "true");
    const microphone = await microphoneOf(camera);
    expect(microphone.getAudioTracks()[0]?.enabled).toBe(false);

    socket.say({ type: "tool", name: "previous_shot", args: {} });
    await expect.poll(() => currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
    await expect.poll(() => socket.sentOf("shot").at(-1)).toEqual({ type: "shot", shot: 0 });
    await expect.element(page.getByRole("img", { name: "Shot 1 of 2" })).toBeVisible();
    // Hanging up hands the shot back to Director Live, with nothing to apologise for.
    await userEvent.click(page.getByRole("button", { name: "End the call" }));
    await onDirectorLive(page);
    expect(FakeSocket.all).toHaveLength(1);
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("keeps Director quiet while a take records the member's voice", async () => {
    canvasCamera();
    const { page } = await openShoot("voice");
    const socket = await call(page);
    socket.say({ type: "audio", pcm16: voice(10) });
    await expect.poll(playing).not.toBeNull();
    socket.say({ type: "tool", name: "start_recording", args: {} });
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    // What it was saying stops as the take starts, and nothing it says plays until it ends.
    await expect.poll(playing).toBeNull();
    socket.say({ type: "audio", pcm16: voice(1) });
    socket.say({ type: "transcript", who: "director", text: "Shh." });
    await expect.element(page.getByText(/Shh\./)).toBeVisible();
    expect(playing()).toBeNull();
    socket.say({ type: "tool", name: "stop_recording", args: {} });
    await expect.element(page.getByText("Director's cut")).toBeVisible();
    socket.say({ type: "audio", pcm16: voice(1) });
    await expect.poll(playing).not.toBeNull();
  });

  it("calls again by itself when the screen is remounted mid-call", async () => {
    canvasCamera();
    const { page } = await openShoot();
    const first = await call(page);
    screen.remount(false);
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    screen.remount(true);
    await expect.poll(() => FakeSocket.all.length).toBe(2);
    FakeSocket.last.open();
    await expect.element(page.getByText("On a call")).toBeVisible();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("drops Director's voice the moment the member talks over it", async () => {
    canvasCamera();
    const { page } = await openShoot();
    const socket = await call(page);
    socket.say({ type: "audio", pcm16: voice(5) });
    await expect.poll(playing).not.toBeNull();
    socket.say({ type: "interrupted" });
    await expect.poll(playing).toBeNull();
    // Nothing it can't read stops the call.
    socket.say("not json");
    socket.say({ type: "audio", pcm16: "" });
    socket.say({ type: "tool", name: "delete_everything", args: {} });
    await expect.element(page.getByText("On a call")).toBeVisible();
  });

  it("ends at its time limit without calling it a failure, and the member can call again", async () => {
    canvasCamera();
    const { page } = await openShoot();
    (await call(page)).hangUp("TIMEOUT");
    await expect
      .element(page.getByText("Calls last up to ten minutes. Call Director again to keep going."))
      .toBeVisible();
    expect(document.querySelector('[data-sonner-toast][data-type="error"]')).toBeNull();
    await onDirectorLive(page);
    await call(page);
  });
});

describe("when the call can't go on, Director Live picks up the same shot", () => {
  it("says the microphone was refused", async () => {
    const camera = canvasCamera();
    const { page, videoId } = await openShoot();
    await expect.poll(() => camera.opened).toHaveLength(1);
    camera.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    touch();
    await userEvent.click(page.getByRole("button", { name: "Call Director" }));
    await expect
      .element(
        page.getByText(
          "Director can't hear you. Allow the microphone in your browser's settings, then call again.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText("Director Live is guiding you on this shot, and your takes are safe."),
      )
      .toBeVisible();
    await onDirectorLive(page);
    await expect.poll(focused).toBe("Call Director");
    expect(FakeSocket.all).toHaveLength(0);
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
  });

  it("keeps the take on screen when the relay fails mid-call", async () => {
    canvasCamera();
    const { page, videoId } = await openShoot();
    const socket = await call(page);
    socket.say({ type: "tool", name: "start_recording", args: {} });
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    socket.say({ type: "tool", name: "stop_recording", args: {} });
    await expect.element(page.getByText("Director's cut")).toBeVisible();

    // The relay's Google token runs out: it says so and hangs up.
    socket.hangUp("UPSTREAM_UNAVAILABLE");
    await expect.element(page.getByText("Gemini can't take the call right now.")).toBeVisible();
    await expect.element(page.getByText("Director's cut")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Keep it" })).toBeEnabled();
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
  });

  it("says why in the call's words, or the API's when the call has none of its own", async () => {
    canvasCamera();
    const { page } = await openShoot();
    const cases: [string | undefined, string][] = [
      [undefined, "The call dropped."],
      ["RATE_LIMITED", "You've made all the calls you can for this hour."],
      [
        "DIRECTOR_CALL_TOO_FAST",
        "The call was sending more than Director can take in, so it ended. Call again.",
      ],
      ["NO_ACTIVE_ORGANIZATION", "Choose a workspace first."],
      ["INTERNAL", "Something went wrong on our side. Please try again."],
    ];
    for (const [code, message] of cases) {
      (await call(page)).hangUp(code);
      await expect.element(page.getByText(message)).toBeVisible();
      await onDirectorLive(page);
    }
  });

  it("says when the microphone goes away mid-call", async () => {
    const camera = canvasCamera();
    const { page } = await openShoot();
    const socket = await call(page);
    const microphone = await microphoneOf(camera);
    microphone.getAudioTracks()[0]?.dispatchEvent(new Event("ended"));
    await expect
      .element(
        page.getByText(
          "Director can't hear you. Allow the microphone in your browser's settings, then call again.",
        ),
      )
      .toBeVisible();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    await onDirectorLive(page);
  });
});

// Kept takes are uploaded to RustFS: the files profile (`bun run test:integration:files`).
describe("a take Director keeps", { tags: ["files"] }, () => {
  it("is sent once, and the call moves on to the next shot", async () => {
    await commands.storageCors();
    canvasCamera();
    const { page, videoId, user } = await openShoot();
    const socket = await call(page);
    socket.say({ type: "tool", name: "start_recording", args: {} });
    await expect.element(page.getByRole("button", { name: "Stop" })).toBeVisible();
    socket.say({ type: "tool", name: "stop_recording", args: {} });
    await expect.element(page.getByText("Director's cut")).toBeVisible();
    // Said twice before the screen catches up: still one take sent.
    socket.say({ type: "tool", name: "next_shot", args: { reason: "great take" } });
    socket.say({ type: "tool", name: "next_shot", args: {} });
    await expect.poll(() => commands.answeredRequests("/rpc/files/completeUpload")).toBe(1);
    const [upload] = await commands.sql<{ id: string }>(
      "SELECT id::text FROM files.file WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    await commands.checkUpload(upload?.id as string);
    await expect
      .poll(() => currentUrl(), { timeout: 15_000 })
      .toBe(`/director/${videoId}/shoot?shot=1&audio=original`);
    await expect.poll(() => socket.sentOf("shot")).toEqual([{ type: "shot", shot: 1 }]);
    expect(FakeSocket.all).toHaveLength(1);
    expect(await commands.answeredRequests("/rpc/director/addTake")).toBe(1);
  });
});

describe("the call's hook", () => {
  const options = (shotIndex = 0) => ({
    videoId: "abcdefghijk",
    shotIndex,
    video: { current: cameraVideo() },
    onTool: vi.fn(),
    onEnd: vi.fn(),
  });

  it("does nothing to mute or measure before there's a call, and hanging up just resets", async () => {
    const events = options();
    const hook = await renderHook(() => useLiveCall(events));
    hook.current.toggleMute();
    hook.current.hold(true);
    expect(hook.current.level()).toBe(0);
    expect(hook.current.muted).toBe(false);
    expect(hook.current.state).toBe("idle");
    hook.current.end();
    await expect.poll(() => hook.current.state).toBe("ended");
    expect(events.onEnd).toHaveBeenCalledWith(null);
  });

  it("survives its effects being torn down and set up again mid-call (Strict Mode, Fast Refresh)", async () => {
    canvasCamera();
    const events = options();
    const state = { current: undefined as ReturnType<typeof useLiveCall> | undefined };
    function Probe() {
      const call = useLiveCall(events);
      state.current = call;
      // As the camera screen does: start whenever the member wants a call and there's none.
      const { state: now, start } = call;
      useEffect(() => {
        if (now === "idle") {
          start();
        }
      }, [now, start]);
      return null;
    }
    await userEvent.click(document.body);
    await renderPage(
      <StrictMode>
        <Remountable>
          <Probe />
        </Remountable>
      </StrictMode>,
    );
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    const first = FakeSocket.last;
    first.open();
    await expect.poll(() => state.current?.state).toBe("live");
    screen.remount(false);
    expect(first.readyState).toBe(FakeSocket.CLOSED);
    screen.remount(true);
    // The call it starts again is a working one: it connects, and hangs up.
    await expect.poll(() => FakeSocket.all.length).toBe(2);
    FakeSocket.last.open();
    await expect.poll(() => state.current?.state).toBe("live");
    state.current?.end();
    await expect.poll(() => state.current?.state).toBe("ended");
    expect(FakeSocket.last.readyState).toBe(FakeSocket.CLOSED);
    expect(events.onEnd).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("tells the relay about a move to another shot made while it was still ringing", async () => {
    canvasCamera();
    const events = options();
    const hook = await renderHook(() => useLiveCall(events));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => FakeSocket.all.length).toBe(1);
    events.shotIndex = 1;
    hook.rerender();
    FakeSocket.last.open();
    await expect.poll(() => FakeSocket.last.sentOf("shot")).toEqual([{ type: "shot", shot: 1 }]);
    // Back and forth again, while live: each move once.
    events.shotIndex = 0;
    hook.rerender();
    hook.rerender();
    await expect.poll(() => FakeSocket.last.sentOf("shot")).toHaveLength(2);
  });

  it("lets the microphone go when the call is hung up while the browser still asks for it", async () => {
    const asked = deferred<MediaStream>();
    const camera = canvasCamera();
    camera.getUserMedia.mockReturnValueOnce(asked.promise);
    const events = options();
    const hook = await renderHook(() => useLiveCall(events));
    await userEvent.click(document.body);
    hook.current.start();
    // A second tap while it's ringing is the same call.
    hook.current.start();
    await expect.poll(() => camera.getUserMedia.mock.calls.length).toBe(1);
    hook.current.toggleMute();
    hook.current.end();
    await expect.poll(() => hook.current.state).toBe("ended");
    expect(events.onEnd).toHaveBeenCalledExactlyOnceWith(null);
    const stream = new AudioContext().createMediaStreamDestination().stream;
    asked.resolve(stream);
    await expect.poll(() => stream.getTracks()[0]?.readyState).toBe("ended");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("fails the call, and turns the microphone off, when it gives no sound", async () => {
    const camera = canvasCamera();
    // A stream with only a picture: nothing for the call to hear.
    camera.getUserMedia.mockImplementationOnce(async () =>
      document.createElement("canvas").captureStream(),
    );
    const events = options();
    const hook = await renderHook(() => useLiveCall(events));
    await userEvent.click(document.body);
    hook.current.start();
    await expect.poll(() => hook.current.state).toBe("failed");
    expect(events.onEnd).toHaveBeenCalledWith("microphone");
    const stream: MediaStream = await camera.getUserMedia.mock.results[0]?.value;
    expect(stream.getTracks()[0]?.readyState).toBe("ended");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("hangs up quietly when the screen goes away, stops the worklet, and skips a frame it can't take", async () => {
    canvasCamera();
    const posted = vi.spyOn(MessagePort.prototype, "postMessage");
    const events = options();
    const hook = await renderHook(() => useLiveCall(events));
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
    // The capture worklet is told to stop processing, not just disconnected.
    expect(posted).toHaveBeenCalledWith("stop");
    await expect.poll(() => socket.onclose).not.toBeNull();
    expect(events.onEnd).not.toHaveBeenCalled();
  });
});

describe("Director's orb", () => {
  it("holds still for anyone who prefers less motion", async () => {
    const real = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query.includes("reduced-motion") ? ({ matches: true } as MediaQueryList) : real(query),
    );
    const level = vi.fn(() => 1);
    await renderPage(<CallOrb level={level} className="size-6" />);
    await cleanup();
    expect(level).not.toHaveBeenCalled();
  });
});
