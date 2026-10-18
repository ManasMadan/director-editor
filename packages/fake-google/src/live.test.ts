/** The mock Google's Live API: the relay's side of Director live, spoken over a real socket. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as z from "zod";
import { startFakeGoogle } from "./index";
import { LIVE_API_PATH } from "./live";

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => {
  fake = await startFakeGoogle({ apiKey: "test-key", liveToken: "live-token" });
});
afterAll(() => fake.close());

const message = z.record(z.string(), z.unknown());

/** A connection to the Live API, as the relay opens one. */
async function connect(token = "live-token") {
  const socket = new WebSocket(`${fake.url.replace("http", "ws")}${LIVE_API_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const received: Record<string, unknown>[] = [];
  socket.on("message", (data) => received.push(message.parse(JSON.parse(String(data)))));
  const closed = new Promise<number>((resolve) => socket.on("close", resolve));
  await new Promise((resolve) => socket.once("open", resolve));
  return {
    socket,
    received,
    closed,
    send: (body: object) => socket.send(JSON.stringify(body)),
    /** Waits for the nth message (0-based) and gives it. */
    async nth(index: number) {
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(index));
      return received[index];
    },
  };
}

const turn = (text: string, turnComplete = true) => ({
  clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete },
});

/** What Director said in a message, if it said anything. */
const saidIn = (received: Record<string, unknown>[]) =>
  received.flatMap((body) => {
    const said = z
      .object({ serverContent: z.object({ outputTranscription: z.object({ text: z.string() }) }) })
      .safeParse(body);
    return said.success ? [said.data.serverContent.outputTranscription.text] : [];
  });

describe("the mock Live API", () => {
  it("answers a setup, hands out handles, and answers the app's notes and the member's turns", async () => {
    const live = await connect();
    live.send({ setup: { model: "projects/p/models/m", sessionResumption: {} } });
    expect(await live.nth(0)).toEqual({ setupComplete: {} });
    expect(await live.nth(1)).toEqual({
      sessionResumptionUpdate: {
        newHandle: expect.stringMatching(/^fake-handle-/),
        resumable: true,
      },
    });
    const session = fake.live.sessions.at(-1);
    expect(session).toMatchObject({ model: "projects/p/models/m", resumedFrom: null, open: true });
    live.send({ realtimeInput: { audio: { data: "AAAA" } } });
    live.send({ realtimeInput: { video: { data: "/9j/" } } });
    live.send(turn("[They just tapped Start shooting, on shot 1.]"));
    live.send(turn("[A take is recording now.]", false));
    live.send(turn("[They flipped to the back camera. Look.]"));
    live.send(turn("[They flipped to the front (selfie) camera. Look.]"));
    live.send(turn("[They've moved on to shot 2.]"));
    live.send(turn("[The take just ended.]"));
    live.send(turn("[Something else.]"));
    live.send(turn("what now?"));
    await vi.waitFor(() =>
      expect(saidIn(live.received)).toEqual([
        "Hey! I'm Director. How much time have you got?",
        "Ooh, the back camera! Now I can see the room.",
        "And we're back on you!",
        "Shot 2! Let's do it.",
        "Nice one! Maybe hold the last moment a beat longer.",
        "Okay!",
        "You said: what now?",
      ]),
    );
    // Each spoken answer comes with a moment of sound.
    expect(live.received[2]).toMatchObject({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
    expect(session).toMatchObject({ audioChunks: 1, frames: 1 });
    expect(session?.turns).toHaveLength(8);
    live.socket.close();
    await vi.waitFor(() => expect(session?.open).toBe(false));
  });

  it("calls a tool on its cue, and says whether it worked", async () => {
    const live = await connect();
    live.send({ setup: { model: "m" } });
    await live.nth(0);
    live.send(turn("ok go to shot 3 please"));
    expect(await live.nth(1)).toEqual({
      toolCall: {
        functionCalls: [{ id: expect.any(String), name: "go_to_shot", args: { shot: 3 } }],
      },
    });
    live.send(turn("switch to the Back camera"));
    expect(await live.nth(2)).toMatchObject({
      toolCall: { functionCalls: [{ name: "switch_camera", args: { to: "back" } }] },
    });
    live.send({
      toolResponse: {
        functionResponses: [
          { id: "call-1", name: "go_to_shot", response: { result: "done" } },
          { name: "switch_camera", response: { result: "refused", why: "a take" } },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(saidIn(live.received)).toEqual(["There you go.", "Let's finish this one first."]),
    );
    expect(fake.live.sessions.at(-1)?.toolResponses).toEqual([
      { result: "done" },
      { result: "refused", why: "a take" },
    ]);
  });

  it("reads the line of the shot it's on, the member's own once they've changed it", async () => {
    const live = await connect();
    const brief = (shot: number, script: string) =>
      `<shot>\nShot ${shot} of 3: The nod.\nScript:\n${script}\n</shot>`;
    live.send({
      setup: {
        model: "m",
        systemInstruction: {
          parts: [{ text: brief(1, '- 0s to 2s: "This one\'s"\n- 2.5s to 4s: "a yes."') }],
        },
      },
    });
    await live.nth(0);
    live.send(turn("can you say my line again?"));
    await vi.waitFor(() => expect(saidIn(live.received)).toEqual([`It's: "This one's a yes."`]));
    // A shot without a line, then one the member changed: the version comes as it joins.
    live.send(turn(`[They've moved on to shot 2.]\n${brief(2, "- nothing is said in this shot")}`));
    live.send(turn("my line?"));
    live.send(turn(`[They've moved on to shot 3.]\n${brief(3, '- 0s to 1s: "Hi."')}`, false));
    live.send(
      turn(
        '[Their version of this shot (it replaces the original where it differs):\n- Their line: "Nan says \\"yes\\"."]',
        false,
      ),
    );
    live.send(turn("say my line"));
    await vi.waitFor(() =>
      expect(saidIn(live.received).slice(1)).toEqual([
        "Shot 2! Let's do it.",
        "No line in this one, just the moves.",
        'It\'s: "Nan says "yes"."',
      ]),
    );
  });

  it("marks an attempt on the roll, quiet once it starts and with a word once it ends", async () => {
    const live = await connect();
    live.send({ setup: { model: "m" } });
    await live.nth(0);
    live.send(turn("ok here goes"));
    expect(await live.nth(1)).toEqual({
      toolCall: {
        functionCalls: [{ id: expect.any(String), name: "mark", args: { event: "start" } }],
      },
    });
    const start = z
      .object({ toolCall: z.object({ functionCalls: z.array(z.object({ id: z.string() })) }) })
      .parse(live.received[1]).toolCall.functionCalls[0]?.id;
    live.send({
      toolResponse: {
        functionResponses: [{ id: start, name: "mark", response: { result: "done" } }],
      },
    });
    live.send(turn("how was that?"));
    expect(await live.nth(2)).toMatchObject({
      toolCall: {
        functionCalls: [{ name: "mark", args: { event: "end", note: "Clear and confident" } }],
      },
    });
    live.send({
      toolResponse: {
        functionResponses: [{ id: "other", name: "mark", response: { result: "done" } }],
      },
    });
    await vi.waitFor(() => expect(saidIn(live.received)).toEqual(["There you go."]));
  });

  it("comments on the member's twist and puts it on the card of the shot they're on", async () => {
    const live = await connect();
    live.send({ setup: { model: "m" } });
    await live.nth(0);
    live.send(turn("what if I do this one with my grandma instead?"));
    // A word about it first (a moment of sound, then the words), then the change.
    await live.nth(3);
    expect(saidIn(live.received)).toEqual(["Ooh, I love that. Let's put it on your card."]);
    expect(live.received[3]).toEqual({
      toolCall: {
        functionCalls: [
          {
            id: expect.any(String),
            name: "adapt_shot",
            args: { shot: 1, action: "You and your grandma do it together" },
          },
        ],
      },
    });
  });

  it("remembers a constraint and re-plans by it, and skips the shot it's on", async () => {
    const live = await connect();
    live.send({ setup: { model: "m" } });
    await live.nth(0);
    live.send(turn("I'm switching indoors"));
    live.send(turn("honestly one angle is fine"));
    live.send(turn("skip this one"));
    await live.nth(3);
    const toolCall = z.object({
      toolCall: z.object({
        functionCalls: z.array(z.object({ name: z.string(), args: z.unknown() })),
      }),
    });
    const calls = live.received
      .slice(1)
      .map((message) =>
        toolCall.parse(message).toolCall.functionCalls.map(({ name, args }) => ({ name, args })),
      );
    expect(calls).toEqual([
      [
        { name: "remember", args: { kind: "place", note: "Indoors" } },
        { name: "replan", args: { instruction: "film every shot indoors" } },
      ],
      [
        { name: "remember", args: { kind: "angles", note: "One angle" } },
        { name: "replan", args: { instruction: "one position, front camera" } },
      ],
      [{ name: "skip_shot", args: { shot: 1 } }],
    ]);
  });

  it("nudges once on a quiet note, says it'll wait on the second, and keeps the rest to itself", async () => {
    const live = await connect();
    live.send({ setup: { model: "m" } });
    await live.nth(0);
    live.send(turn("[They've been quiet for 15 seconds. One light nudge, a few words.]"));
    live.send(turn("[They keep getting cut off, probably by noise.]", false));
    live.send(turn("[They've been quiet again, the second time on this shot.]"));
    live.send(turn("[They called the countdown off: no take this time.]"));
    await vi.waitFor(() =>
      expect(saidIn(live.received)).toEqual([
        "Want to give it a go?",
        "I'll wait. Just say when.",
        "All good? Go whenever you're ready.",
      ]),
    );
  });

  it("resumes from a handle, and warns open connections that they'll close", async () => {
    const live = await connect();
    live.send({ setup: { model: "m", sessionResumption: { handle: "fake-handle-1" } } });
    await live.nth(1);
    expect(fake.live.sessions.at(-1)?.resumedFrom).toBe("fake-handle-1");
    fake.live.goAway();
    expect(await live.nth(2)).toEqual({ goAway: { timeLeft: "5s" } });
  });

  it("refuses a connection without its token, or one that doesn't start with a setup", async () => {
    const refused = new WebSocket(`${fake.url.replace("http", "ws")}${LIVE_API_PATH}`, {
      headers: { authorization: "Bearer wrong" },
    });
    const status = await new Promise<number | undefined>((resolve) => {
      refused.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      refused.on("error", () => resolve(undefined));
    });
    expect(status).toBe(401);
    const early = await connect();
    early.send(turn("hello"));
    expect(await early.closed).toBe(1007);
    const garbled = await connect();
    garbled.socket.send("not json");
    expect(await garbled.closed).toBe(1007);
    // After its setup too: something it can't read ends the connection.
    const later = await connect();
    later.send({ setup: { model: "m" } });
    await later.nth(0);
    later.send({ clientContent: { turns: "nope" } });
    expect(await later.closed).toBe(1007);
  });

  it("leaves other paths' upgrades alone", async () => {
    const elsewhere = new WebSocket(`${fake.url.replace("http", "ws")}/ws/other`, {
      headers: { authorization: "Bearer live-token" },
    });
    const status = await new Promise<number | undefined>((resolve) => {
      elsewhere.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      elsewhere.on("error", () => resolve(undefined));
    });
    expect(status).toBe(404);
  });
});

describe("the mock Google's Live API token", () => {
  it("is the key, unless told otherwise", async () => {
    const other = await startFakeGoogle({ apiKey: "the-key" });
    const socket = new WebSocket(`${other.url.replace("http", "ws")}${LIVE_API_PATH}`, {
      headers: { authorization: "Bearer the-key" },
    });
    await new Promise((resolve) => socket.once("open", resolve));
    // Closing the mock Google ends its open connections.
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await other.close();
    await closed;
  });
});
