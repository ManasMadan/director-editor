/**
 * Director's slower line against the mock Google's Vertex AI stand-in: the request it
 * sends (persona, shot, tools, frame, what was said), the replies and tool calls it hands
 * back, checked like Live's, and how it fails.
 */
import { createServer } from "node:http";
import type { DirectorChatInput } from "@repo/contracts/api";
import { type ShotPlan, shotPlanSchema } from "@repo/contracts/api";
import { videoIdSchema } from "@repo/contracts/ids";
import { LIVE_TOOLS } from "@repo/contracts/live";
import { CHAT_USAGE, startFakeGoogle } from "@repo/fake-google";
import { isAppError } from "@repo/nest-common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { type ChatSpend, chatUpstream, DirectorChat } from "./live.chat";
import { PERSONA } from "./live.persona";
import { functionDeclarations } from "./live.setup";

const TOKEN = "chat-token";
const auth = { accessToken: () => Promise.resolve(TOKEN) };

const shot = {
  kind: "video",
  title: "The pour",
  purpose: "Open on the coffee.",
  sourceStartSeconds: 0,
  sourceEndSeconds: 3,
  durationSeconds: 3,
  camera: "back",
  scene: "In a busy market",
  sceneLandmark: "stall",
  framing: {
    shotSize: "close-up",
    subject: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 },
    note: "The mug in the middle.",
  },
  phoneAngle: { pitch: -20, roll: 0, tolerance: 10, height: "chest" },
  pose: { description: "One hand pouring", keypoints: [] },
  steps: [{ atSeconds: 0, instruction: "Pour slowly", cameraMove: "static" }],
  script: [{ startSeconds: 0, endSeconds: 3, text: "Good morning, coffee first!" }],
};

const plan: ShotPlan = shotPlanSchema.parse({
  title: "Morning coffee",
  format: "GRWM",
  summary: "Making coffee before work.",
  audio: "speech",
  durationSeconds: 6,
  shots: [shot, { ...shot, title: "The sip", steps: [], script: [] }],
});

const said = (text: string, more: Partial<DirectorChatInput> = {}): DirectorChatInput => ({
  videoId: videoIdSchema.parse("dQw4w9WgXcQ"),
  shotIndex: 0,
  turn: { kind: "said", text },
  adaptations: [],
  recent: [],
  answers: [],
  ...more,
});

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => {
  fake = await startFakeGoogle({ apiKey: "key", liveToken: TOKEN });
});
afterAll(() => fake.close());

/** The AI ledger, standing in: each turn it was asked to count, and what each spent. */
function ledgerOf() {
  const turns: ChatSpend[] = [];
  return {
    turns,
    charge<T>(turn: (spent: ChatSpend) => Promise<T>) {
      const spent = { inputTokens: 0, outputTokens: 0, counted: true };
      turns.push(spent);
      return turn(spent);
    },
  };
}

function chatAt(url: string | undefined, log = vi.fn(), ledger = ledgerOf()) {
  const chat = new DirectorChat(
    chatUpstream({ project: "my-project", model: "gemini-x", url, auth }),
    log,
  );
  return { reply: (shots: ShotPlan, input: DirectorChatInput) => chat.reply(shots, input, ledger) };
}

/** Every request the chat sends, through a recorder in front of the mock. */
async function recorded() {
  const bodies: unknown[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(z.instanceof(Buffer).parse(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    bodies.push(JSON.parse(text));
    paths.push(String(request.url));
    const answer = await fetch(`${fake.url}${request.url}`, {
      method: "POST",
      headers: { authorization: String(request.headers.authorization) },
      body: text,
    });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(await answer.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    paths,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A Gemini that answers each request with the next of `answers`, as written, recording each. */
async function scripted(answers: string[]) {
  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(z.instanceof(Buffer).parse(chunk));
    }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(answers[bodies.length - 1]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const requestSchema = z.object({
  systemInstruction: z.object({ parts: z.array(z.object({ text: z.string() })) }),
  contents: z.array(z.object({ role: z.string(), parts: z.array(z.looseObject({})) })),
  tools: z.array(z.object({ functionDeclarations: z.array(z.object({ name: z.string() })) })),
});

describe("Director's slower line", () => {
  it("is off without a Google Cloud project", async () => {
    const off = new DirectorChat(chatUpstream({ project: undefined, model: "m", auth }), vi.fn());
    const ledger = ledgerOf();
    await expect(off.reply(plan, said("hi"), ledger)).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
    });
    expect(ledger.turns).toEqual([]);
  });

  it("addresses the model at Vertex AI's global endpoint by default", () => {
    expect(chatUpstream({ project: "p-123456", model: "gemini-3.8-flash", auth })?.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/p-123456/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
    );
  });

  it("asks with Live's persona, the shot, the same tools, the frame and what was said", async () => {
    const proxy = await recorded();
    try {
      const reply = await chatAt(proxy.url).reply(
        plan,
        said("can you hear me?", {
          frame: "A".repeat(200),
          recent: [{ who: "director", text: "How much time have you got?" }],
          answers: [{ tool: "adapt_shot", result: "busy" }],
          adaptations: [{ shot: 0, line: "Coffee, then everything else." }],
        }),
      );
      expect(reply).toEqual({ reply: "Got it.", calls: [] });
      const request = requestSchema.parse(proxy.bodies[0]);
      const system = request.systemInstruction.parts[0]?.text ?? "";
      expect(system).toContain(PERSONA);
      expect(system).toContain("Shot 1 of 2: The pour");
      expect(system).toContain('- Their line: "Coffee, then everything else."');
      expect(system).toContain("slower line");
      // Live's own declarations, every tool of them.
      expect(JSON.stringify(proxy.bodies[0])).toContain(JSON.stringify(functionDeclarations));
      expect(request.tools[0]?.functionDeclarations.map((tool) => tool.name).sort()).toEqual(
        [...LIVE_TOOLS].sort(),
      );
      const parts = JSON.stringify(request.contents[0]?.parts);
      expect(parts).toContain("You: How much time have you got?");
      expect(parts).toContain("adapt_shot");
      expect(parts).toContain("refused");
      expect(parts).toContain('"inlineData":{"mimeType":"image/jpeg"');
      expect(parts).toContain("can you hear me?");
      expect(proxy.paths[0]).toBe(
        "/v1/projects/my-project/locations/global/publishers/google/models/gemini-x:generateContent",
      );
    } finally {
      await proxy.close();
    }
  });

  it("briefs with the member's whole version, and hears a chip taken away", async () => {
    const proxy = await recorded();
    try {
      const version = {
        notes: [{ kind: "place" as const, note: "Indoors" }],
        shots: [{ shot: 0, where: "In your living room" }],
        skipped: [],
        gaps: [],
      };
      await chatAt(proxy.url).reply(plan, said("ok", { version }));
      const system = requestSchema.parse(proxy.bodies[0]).systemInstruction.parts[0]?.text;
      expect(system).toContain("In your living room");
      expect(system).toContain('- place: "Indoors"');
      expect(system).not.toContain("kitchen counter");
      await chatAt(proxy.url).reply(
        plan,
        said("", { turn: { kind: "forgot", memory: "place", note: "Indoors" }, version }),
      );
      expect(JSON.stringify(proxy.bodies.at(-1))).toContain('removed \\"Indoors\\"');
    } finally {
      await proxy.close();
    }
  });

  it("tells Gemini to mark attempts while the roll records, and hears the roll's changes", async () => {
    const proxy = await recorded();
    try {
      await chatAt(proxy.url).reply(plan, said("ok going", { rolling: true }));
      expect(JSON.stringify(proxy.bodies[0])).toContain("call mark with event start");
      const paused = await chatAt(proxy.url).reply(plan, {
        ...said("x"),
        turn: { kind: "roll", state: "paused" },
      });
      expect(paused).toEqual({ reply: "", calls: [] });
      const done = await chatAt(proxy.url).reply(plan, {
        ...said("x"),
        turn: { kind: "roll", state: "done" },
      });
      expect(done.reply).toBe("Nice, that looked good.");
      expect(proxy.bodies).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it("adapts the card for 'I'm fine inside', in the same reply as its line", async () => {
    const reply = await chatAt(fake.url).reply(plan, said("nah I'm fine inside"));
    expect(reply).toEqual({
      reply: "Totally, inside it is. Stand so the window's just behind you.",
      calls: [{ name: "adapt_shot", shot: 0, where: "Inside, by a window" }],
    });
  });

  it("asks again for words when Gemini answers with only a call, telling it the call's outcome", async () => {
    const proxy = await recorded();
    try {
      const reply = await chatAt(proxy.url).reply(plan, said("go to shot 2"));
      expect(reply).toEqual({
        reply: "Done, you're there.",
        calls: [{ name: "go_to_shot", shot: 1 }],
      });
      const second = requestSchema.parse(proxy.bodies[1]);
      expect(second.contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
      // The model's own parts go back as they came, thought signature and all.
      expect(JSON.stringify(second.contents[1])).toContain("thoughtSignature");
      expect(JSON.stringify(second.contents[2])).toContain('"result":"done"');
    } finally {
      await proxy.close();
    }
  });

  it("refuses a call the plan can't do, and tells Gemini why", async () => {
    const proxy = await recorded();
    try {
      const reply = await chatAt(proxy.url).reply(plan, said("go to shot 9"));
      expect(reply).toEqual({ reply: "Done, you're there.", calls: [] });
      expect(JSON.stringify(proxy.bodies[1])).toContain("There's no shot 9");
    } finally {
      await proxy.close();
    }
  });

  it("opens the slower line with a hello, and answers what happened on screen", async () => {
    const chat = chatAt(fake.url);
    const opening = await chat.reply(plan, { ...said("x"), turn: { kind: "start" } });
    expect(opening.reply).toContain("a bit slow");
    const flipped = await chat.reply(plan, {
      ...said("x"),
      turn: { kind: "camera", facing: "back" },
    });
    expect(flipped.reply).toBe("Nice, that looked good.");
    const take = await chat.reply(plan, {
      ...said("x"),
      turn: { kind: "take", state: "recorded" },
    });
    expect(take.reply).toBe("Nice, that looked good.");
  });

  it("counts a turn in the ledger with what Gemini said each of its requests cost", async () => {
    const ledger = ledgerOf();
    await chatAt(fake.url, vi.fn(), ledger).reply(plan, said("hello"));
    // Asked twice: once for the call, once for the words to go with it.
    await chatAt(fake.url, vi.fn(), ledger).reply(plan, said("go to shot 2"));
    const output = CHAT_USAGE.totalTokenCount - CHAT_USAGE.promptTokenCount;
    expect(ledger.turns).toEqual([
      { inputTokens: CHAT_USAGE.promptTokenCount, outputTokens: output, counted: true },
      { inputTokens: 2 * CHAT_USAGE.promptTokenCount, outputTokens: 2 * output, counted: true },
    ]);
  });

  it("says when an answer didn't tell what it cost, so the turn keeps its reservation", async () => {
    const silent = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi." }] } }] }));
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = z.object({ port: z.number() }).parse(silent.address());
    const ledger = ledgerOf();
    try {
      const reply = await chatAt(`http://127.0.0.1:${port}`, vi.fn(), ledger).reply(
        plan,
        said("hello"),
      );
      expect(reply.reply).toBe("Hi.");
      expect(ledger.turns).toEqual([{ inputTokens: 0, outputTokens: 0, counted: false }]);
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("says nothing, asks no one and counts nothing for a note Director only needs to know", async () => {
    const proxy = await recorded();
    const ledger = ledgerOf();
    try {
      const reply = await chatAt(proxy.url, vi.fn(), ledger).reply(plan, {
        ...said("x"),
        turn: { kind: "take", state: "recording" },
      });
      expect(reply).toEqual({ reply: "", calls: [] });
      expect(proxy.bodies).toEqual([]);
      expect(ledger.turns).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("tells Gemini the last lines said, theirs and its own", async () => {
    const proxy = await recorded();
    try {
      await chatAt(proxy.url).reply(plan, {
        ...said("hello"),
        recent: [
          { who: "you", text: "Is the light ok?" },
          { who: "director", text: "It looks great." },
        ],
      });
      const [body] = proxy.bodies;
      const sent = JSON.stringify(requestSchema.parse(body).contents);
      expect(sent).toContain("Them: Is the light ok?");
      expect(sent).toContain("You: It looks great.");
    } finally {
      await proxy.close();
    }
  });

  it("answers a call to a tool it doesn't have as unknown, then says what it did", async () => {
    const gemini = await scripted([
      JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "fly" } }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "I can't do that one." }] } }] }),
    ]);
    try {
      const reply = await chatAt(gemini.url).reply(plan, said("can you fly?"));
      expect(reply).toEqual({ reply: "I can't do that one.", calls: [] });
      const second = requestSchema.parse(gemini.bodies[1]);
      expect(second.contents.at(-1)?.parts).toEqual([
        { functionResponse: { name: "fly", response: { error: "unknown tool" } } },
      ]);
    } finally {
      await gemini.close();
    }
  });

  it("says nothing when Gemini answers with no candidates", async () => {
    const gemini = await scripted([JSON.stringify({ candidates: [] })]);
    try {
      expect(await chatAt(gemini.url).reply(plan, said("hello"))).toEqual({ reply: "", calls: [] });
    } finally {
      await gemini.close();
    }
  });

  it("is UPSTREAM_UNAVAILABLE, and logs it, when Gemini's answer isn't JSON", async () => {
    const gemini = await scripted(["<html>busy</html>"]);
    const log = vi.fn();
    try {
      await expect(chatAt(gemini.url, log).reply(plan, said("hello"))).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
      });
      expect(log).toHaveBeenCalledWith(
        "error",
        { status: 200, body: null },
        "director chat refused",
      );
    } finally {
      await gemini.close();
    }
  });

  it("refuses a shot the plan doesn't have", async () => {
    await expect(chatAt(fake.url).reply(plan, said("hi", { shotIndex: 5 }))).rejects.toMatchObject({
      code: "DIRECTOR_SHOT_NOT_FOUND",
    });
  });

  it("is UPSTREAM_UNAVAILABLE, and logs why, when Gemini is out of reach or refuses", async () => {
    fake.chatOutage(true);
    const log = vi.fn();
    try {
      const error = await chatAt(fake.url, log)
        .reply(plan, said("hi"))
        .catch((e: unknown) => e);
      expect(isAppError(error) && error.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(log).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({ status: 503 }),
        "director chat refused",
      );
    } finally {
      fake.chatOutage(false);
    }
    const unreachable = vi.fn();
    const error = await chatAt("http://127.0.0.1:1", unreachable)
      .reply(plan, said("hi"))
      .catch((e: unknown) => e);
    expect(isAppError(error) && error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(unreachable).toHaveBeenCalledWith("error", expect.anything(), "director chat failed");
  });
});
