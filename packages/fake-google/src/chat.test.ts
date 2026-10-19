import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAT_USAGE, startFakeGoogle } from "./index";

const TOKEN = "live-token";
const PATH = "/v1/projects/p/locations/global/publishers/google/models/gemini-x:generateContent";

let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => {
  fake = await startFakeGoogle({ apiKey: "key", liveToken: TOKEN });
});
afterAll(() => fake.close());

const system = { parts: [{ text: "You're Director.\nShot 2 of 3: The sip." }] };

function ask(body: unknown, token = TOKEN) {
  return fetch(`${fake.url}${PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const turn = (text: string) => ({
  systemInstruction: system,
  contents: [{ role: "user", parts: [{ text }] }],
});

async function partsOf(body: unknown) {
  const response = await ask(body);
  expect(response.status).toBe(200);
  const answer = (await response.json()) as { candidates: { content: { parts: unknown[] } }[] };
  return answer.candidates[0]?.content.parts;
}

describe("the slower line's generateContent", () => {
  it("says what each answer cost, as Vertex does", async () => {
    const response = await ask(turn("hello?"));
    expect(await response.json()).toMatchObject({ usageMetadata: CHAT_USAGE });
  });

  it("answers by what was said last", async () => {
    expect(await partsOf(turn("hello?"))).toEqual([{ text: "Got it." }]);
    expect(await partsOf(turn("[They flipped the camera.]"))).toEqual([
      { text: "Nice, that looked good." },
    ]);
    expect(await partsOf(turn("[You're on the slower line for now.]"))).toEqual([
      { text: "Hey! I'm a bit slow to answer right now. How much time have you got?" },
    ]);
    expect(await partsOf(turn("I'm fine inside"))).toEqual([
      { text: "Totally, inside it is. Stand so the window's just behind you." },
      {
        functionCall: { name: "adapt_shot", args: { shot: 2, where: "Inside, by a window" } },
        thoughtSignature: "c2lnbmVk",
      },
    ]);
    expect(await partsOf(turn("go to shot 3"))).toEqual([
      { functionCall: { name: "go_to_shot", args: { shot: 3 } }, thoughtSignature: "c2lnbmVk" },
    ]);
    const answered = {
      systemInstruction: { parts: [{ text: "no shot here" }] },
      contents: [{ role: "user", parts: [{ functionResponse: { name: "go_to_shot" } }] }],
    };
    expect(await partsOf(answered)).toEqual([{ text: "Done, you're there." }]);
  });

  it("refuses a wrong token, a body it can't read, and everything during an outage", async () => {
    expect((await ask(turn("hi"), "other")).status).toBe(401);
    expect((await ask({ contents: [] })).status).toBe(400);
    expect((await ask("not json")).status).toBe(400);
    expect((await ask("")).status).toBe(400);
    fake.chatOutage(true);
    expect((await ask(turn("hi"))).status).toBe(503);
    fake.chatOutage(false);
    expect((await ask(turn("hi"))).status).toBe(200);
  });

  it("starts from shot 1 when the instruction names none", async () => {
    const parts = await partsOf({
      systemInstruction: { parts: [{ text: "no shot" }] },
      contents: [{ role: "user", parts: [{ text: "inside please" }] }],
    });
    expect(JSON.stringify(parts)).toContain('"shot":1');
  });
});
