/**
 * Director's slower line on its own: turns in order with what the shoot is doing, its
 * replies voiced and then captioned, its tool calls answered with the next turn, and how
 * it ends or waits when the API can't help. The API is the line's own interface,
 * answered here turn by turn; the shoot screen's use of it is director-live.test.tsx's.
 */
import { ORPCError } from "@orpc/client";
import type { DirectorChatInput, DirectorChatReply } from "@repo/contracts/api";
import { EMPTY_VERSION } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SlowLineApi, startSlowSession } from "@/modules/director/lib/slow-session";
import { cameraVideo, deferred, FakeRecognizer, fakeRecognizer, silentWav } from "../support";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const said = (reply: string, calls: DirectorChatReply["calls"] = []) => ({ reply, calls });

/** A slower line with every event recorded, Director answering each turn with `answer`. */
function line(
  answer: (input: DirectorChatInput) => DirectorChatReply | Promise<DirectorChatReply>,
  options: { held?: boolean; video?: HTMLVideoElement | null; speak?: SlowLineApi["speak"] } = {},
) {
  fakeRecognizer();
  const turns: DirectorChatInput[] = [];
  const events: string[] = [];
  const api: SlowLineApi = {
    chat: async (input) => {
      turns.push(input);
      return answer(input);
    },
    speak:
      options.speak ??
      (async () => ({ url: silentWav(0.1), expiresAt: new Date(Date.now() + 60_000) })),
  };
  const session = startSlowSession({
    videoId: "abcdefghijk",
    shot: 0,
    held: options.held ?? false,
    video: { current: options.video === undefined ? null : options.video },
    version: () => EMPTY_VERSION,
    api,
    events: {
      onLive: () => events.push("live"),
      onTranscript: (who, text) => events.push(`${who}: ${text}`),
      onTurn: () => events.push("turn"),
      onInterrupted: () => events.push("interrupted"),
      onTool: (id, call) => events.push(`tool ${id} ${call.name}`),
      onSpeaking: () => undefined,
      onDeaf: () => events.push("deaf"),
      onEnd: (failure) => events.push(`end ${failure}`),
      onSaid: (text) => events.push(`said ${text}`),
      onAway: (away) => events.push(`away ${away}`),
    },
  });
  return { session, turns, events };
}

describe("the slower line", () => {
  it("speaks first, then answers each turn in order with what the shoot is doing", async () => {
    const { session, turns, events } = line((input) =>
      input.turn.kind === "start" ? said("Hi! How long have you got?") : said(""),
    );
    await expect.poll(() => events).toContain("director: Hi! How long have you got?");
    expect(events[0]).toBe("live");
    session.moveTo(2);
    session.roll("recording");
    session.take("recorded");
    // A take still going isn't a turn of its own.
    session.take("recording");
    session.say("All good");
    await expect.poll(() => turns.length).toBe(4);
    expect(turns.map((turn) => turn.turn.kind)).toEqual(["start", "roll", "take", "said"]);
    expect(turns[1]).toMatchObject({ shotIndex: 2, rolling: true });
    // The last lines said go with each turn: the turn's own words are in it, not them.
    expect(turns[3]?.recent).toEqual([{ who: "director", text: "Hi! How long have you got?" }]);
    session.roll("paused");
    await expect.poll(() => turns.at(-1)?.rolling).toBe(false);
    expect(turns.at(-1)?.recent).toEqual([
      { who: "director", text: "Hi! How long have you got?" },
      { who: "you", text: "All good" },
    ]);
    // The member's version rides with every turn: these send nothing of their own.
    session.share();
    session.restored();
    session.forgot({ kind: "props", note: "The red mug" });
    await expect
      .poll(() => turns.at(-1)?.turn)
      .toEqual({
        kind: "forgot",
        memory: "props",
        note: "The red mug",
      });
    // No camera on the page: every turn went without a picture.
    expect(turns.every((turn) => turn.frame === undefined)).toBe(true);
    expect(session.level()).toBeGreaterThanOrEqual(0);
    session.leave();
  });

  it("hands the screen Director's calls, and tells Director what came of them", async () => {
    const { session, turns, events } = line((input) =>
      input.turn.kind === "start"
        ? said("", [
            { name: "go_to_shot", shot: 1 },
            { name: "switch_camera", to: "front" },
          ])
        : said(""),
    );
    await expect.poll(() => events).toContain("tool slow-2 switch_camera");
    expect(events).toContain("tool slow-1 go_to_shot");
    session.answer("slow-1", "done");
    // One it never asked: nothing to tell.
    session.answer("slow-9", "done");
    session.say("Done");
    await expect.poll(() => turns[1]?.answers).toEqual([{ tool: "go_to_shot", result: "done" }]);
    // Told once: the turn after carries none.
    session.say("And now?");
    await expect.poll(() => turns[2]?.answers).toEqual([]);
    // An empty reply is a turn without words: nothing captioned.
    expect(events.filter((event) => event.startsWith("director:"))).toEqual([]);
    session.leave();
  });

  it("sends the camera's picture with each turn, but none while paused or while there's none", async () => {
    const video = cameraVideo({ width: 64, height: 114 });
    const { session, turns } = line(() => said(""), { video });
    await expect.poll(() => turns.length).toBe(1);
    expect(turns[0]?.frame).toEqual(expect.any(String));
    session.mute(true);
    session.say("paused now");
    await expect.poll(() => turns.length).toBe(2);
    expect(turns[1]?.frame).toBeUndefined();
    session.mute(false);
    // A picture the browser can't encode: the turn goes with the words alone.
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((done) => done(null));
    session.say("can you see me?");
    await expect.poll(() => turns.length).toBe(3);
    expect(turns[2]?.frame).toBeUndefined();
    encode.mockRestore();
    // The camera turned round: once its picture is up, Director looks at the new view.
    await session.camera("front");
    await expect.poll(() => turns.at(-1)?.turn).toEqual({ kind: "camera", facing: "front" });
    session.leave();
  });

  it("captions a reply without a voice while held, and when the voice can't be had", async () => {
    const speak = vi.fn<SlowLineApi["speak"]>(async () => {
      throw new ORPCError("UPSTREAM_UNAVAILABLE");
    });
    const held = line(() => said("Rolling, go!"), { held: true, speak });
    await expect.poll(() => held.events).toContain("director: Rolling, go!");
    expect(speak).not.toHaveBeenCalled();
    held.session.hold(false);
    held.session.say("again");
    await expect.poll(() => speak.mock.calls.length).toBe(1);
    await expect.poll(() => held.events.filter((event) => event === "turn")).toHaveLength(2);
    held.session.hold(true);
    held.session.leave();
    // A voice that isn't a WAV it can read: captioned all the same.
    const unreadable = line(() => said("Can you hear me?"), {
      speak: async () => ({
        url: URL.createObjectURL(new Blob(["not a wav"])),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    await expect.poll(() => unreadable.events).toContain("director: Can you hear me?");
    unreadable.session.leave();
  });

  it("says Gemini is out of reach until a turn gets through, and keeps the session", async () => {
    let reachable = false;
    const { session, events } = line(() => {
      if (!reachable) {
        throw new ORPCError("UPSTREAM_UNAVAILABLE");
      }
      return said("Back!");
    });
    await expect.poll(() => events).toContain("away true");
    session.say("hello?");
    await expect.poll(() => events.filter((event) => event === "away true")).toHaveLength(1);
    reachable = true;
    session.say("hello again");
    await expect.poll(() => events).toContain("away false");
    await expect.poll(() => events).toContain("director: Back!");
    session.leave();
  });

  it("ends when the slower line itself is off, and says nothing after it's let go", async () => {
    const off = line(() => {
      throw new ORPCError("FEATURE_DISABLED");
    });
    await expect.poll(() => off.events).toContain("end FEATURE_DISABLED");
    // Over: a turn after it isn't sent.
    off.session.say("still there?");
    expect(off.events.filter((event) => event.startsWith("end"))).toHaveLength(1);

    // Let go while a reply, or a failure, is on its way: neither reaches the screen.
    const reply = deferred<DirectorChatReply>();
    const leaving = line(() => reply.promise);
    await expect.poll(() => leaving.turns.length).toBe(1);
    leaving.session.leave();
    reply.resolve(said("Too late"));
    const failure = deferred<DirectorChatReply>();
    const failing = line(() => failure.promise);
    await expect.poll(() => failing.turns.length).toBe(1);
    failing.session.leave();
    failure.reject(new ORPCError("UPSTREAM_UNAVAILABLE"));
    // Both settled: the queue's next turn runs after them, and isn't sent either.
    leaving.session.say("bye");
    failing.session.say("bye");
    await Promise.all([reply.promise, failure.promise.catch(() => undefined)]);
    expect(leaving.events).toEqual(["live"]);
    expect(failing.events).toEqual(["live"]);
    expect(leaving.turns).toHaveLength(1);
  });

  it("captions a reply whose voice lands after the line was let go, without a word", async () => {
    const voice = deferred<{ url: string; expiresAt: Date }>();
    const { session, events } = line(() => said("Bye for now"), { speak: () => voice.promise });
    await expect.poll(() => events.length).toBe(1);
    session.leave();
    voice.resolve({ url: silentWav(0.1), expiresAt: new Date() });
    await voice.promise;
    expect(events).toEqual(["live"]);
  });

  it("hears what the member says out loud, as a turn", async () => {
    const { session, turns, events } = line(() => said(""));
    await expect.poll(() => turns.length).toBe(1);
    FakeRecognizer.last?.hear("Ready when you are");
    await expect.poll(() => turns.length).toBe(2);
    expect(turns[1]?.turn).toEqual({ kind: "said", text: "Ready when you are" });
    expect(events).toContain("said Ready when you are");
    session.leave();
  });
});
