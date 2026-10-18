import { zSceneCheck, zShotPlan } from "@repo/ai-client/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { CATALOG, shortOf } from "./catalog";
import { startFakeGoogle } from "./index";

const KEY = "test-key";

/**
 * apps/ai/app/schemas.py TakeReview: the review agent's output, which isn't in the
 * service's OpenAPI document (no route returns it), so it's spelled out here.
 */
const zTakeReview = z.strictObject({
  bestStartSeconds: z.number().min(0).max(60).nullable(),
  bestEndSeconds: z.number().min(0.1).max(60).nullable(),
  score: z.int().min(0).max(100),
  feedback: z.string().min(1).max(300),
});
let fake: Awaited<ReturnType<typeof startFakeGoogle>>;
beforeAll(async () => {
  fake = await startFakeGoogle({ apiKey: KEY });
});
afterAll(() => fake.close());

/** A generateContent body as google-genai sends it for one of Director's agents. */
function ask(field: string, parts: object[]) {
  return {
    contents: [{ role: "user", parts }],
    tools: [
      {
        functionDeclarations: [
          { name: "final_result", parameters_json_schema: { properties: { [field]: {} } } },
        ],
      },
    ],
  };
}

async function gemini(body: object, key = KEY) {
  const response = await fetch(`${fake.url}/v1beta/models/gemini-mock:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function argsOf(json: Record<string, unknown>) {
  const reply = json as {
    candidates: { content: { parts: { functionCall: { args: unknown } }[] } }[];
  };
  return reply.candidates[0]?.content.parts[0]?.functionCall.args;
}

const youtube = (path: string, key = KEY) =>
  fetch(`${fake.url}/youtube/v3/${path}${path.includes("?") ? "&" : "?"}key=${key}`).then(
    async (r) => ({
      status: r.status,
      json: (await r.json()) as { items?: { id: unknown }[] },
    }),
  );

const watch = (id: string) => ({
  fileData: { file_uri: `https://www.youtube.com/watch?v=${id}`, mime_type: "video/mp4" },
});
const shotPart = (shot: object) => ({ text: `The shot:\n${JSON.stringify(shot)}` });

describe("the mock Gemini", () => {
  it("writes each kind of short's plan, valid for the AI service", async () => {
    for (const short of CATALOG) {
      const { status, json } = await gemini(
        ask("shots", [watch(short.videoId), { text: "Write the shot plan." }]),
      );
      expect(status).toBe(200);
      const plan = zShotPlan.parse(argsOf(json));
      expect(plan.shots.length).toBeGreaterThan(0);
      expect(json).toMatchObject({
        modelVersion: "gemini-mock",
        usageMetadata: { totalTokenCount: expect.any(Number) },
      });
    }
    const grwm = zShotPlan.parse(argsOf((await gemini(ask("shots", [watch("OPf0YbXqDm0")]))).json));
    // The PRD's GRWM: six shots, four videos and two photos.
    expect(grwm.shots.map((shot) => shot.kind)).toEqual([
      "video",
      "video",
      "video",
      "video",
      "photo",
      "photo",
    ]);
    // The office GRWM follows its video's cuts: back to back from the first frame to the
    // last, each shot as long as its part of the original, and no script over the song.
    const office = zShotPlan.parse(
      argsOf((await gemini(ask("shots", [watch("HasaZYkwYds")]))).json),
    );
    expect(office).toMatchObject({ audio: "music", durationSeconds: 26.1 });
    expect(office.shots).toHaveLength(12);
    expect(office.shots.filter((shot) => shot.kind === "photo").map((shot) => shot.title)).toEqual([
      "The watch",
      "The fragrance",
    ]);
    expect(office.shots[0]?.sourceStartSeconds).toBe(0);
    expect(office.shots.at(-1)?.sourceEndSeconds).toBe(office.durationSeconds);
    office.shots.forEach((shot, index) => {
      expect(shot.durationSeconds).toBeCloseTo(shot.sourceEndSeconds - shot.sourceStartSeconds);
      expect(shot.script).toEqual([]);
      const next = office.shots[index + 1];
      if (next) {
        expect(next.sourceStartSeconds).toBe(shot.sourceEndSeconds);
      }
    });
    const pasted = zShotPlan.parse(
      argsOf((await gemini(ask("shots", [watch("AbCdEfGhIjK")]))).json),
    );
    expect(pasted.shots[0]?.sceneLandmark).toBe("tree");
  });

  it("walks the member to the landmark, then says they're in place", async () => {
    const shot = { title: "The hook", sceneLandmark: "tree" };
    const frame = { inlineData: { mimeType: "image/jpeg", data: "/9j/AAAA" } };
    const checks = [];
    // Twice through: once arrived, the walk starts over for the next take.
    for (let i = 0; i < 4; i++) {
      checks.push(
        zSceneCheck.parse(argsOf((await gemini(ask("inPlace", [shotPart(shot), frame]))).json)),
      );
    }
    expect(checks.map((check) => [check.inPlace, check.direction])).toEqual([
      [false, "left"],
      [false, "left"],
      [true, "none"],
      [false, "left"],
    ]);
    // It can't see the frame, so it never claims where the landmark is in it.
    expect(checks.every((check) => check.landmark === null)).toBe(true);
    const anywhere = zSceneCheck.parse(
      argsOf(
        (await gemini(ask("inPlace", [shotPart({ title: "Free", sceneLandmark: null })]))).json,
      ),
    );
    expect(anywhere).toMatchObject({ inPlace: true, landmark: null });
    const unknown = zSceneCheck.parse(
      argsOf((await gemini(ask("inPlace", [{ text: "hello" }]))).json),
    );
    expect(unknown.inPlace).toBe(true);
  });

  it("reviews a take: the shot's length from just after it starts, or nothing for a photo", async () => {
    const take = {
      inlineData: {
        mimeType: "video/webm",
        data: "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC",
      },
    };
    const video = zTakeReview.parse(
      argsOf(
        (
          await gemini(
            ask("bestStartSeconds", [
              shotPart({ title: "The top", kind: "video", durationSeconds: 3.5 }),
              take,
            ]),
          )
        ).json,
      ),
    );
    expect([video.bestStartSeconds, video.bestEndSeconds]).toEqual([0.3, 3.8]);
    expect(video.score).toBeGreaterThanOrEqual(70);
    expect(video.feedback).toContain("The top");
    // Billed like Gemini: a second of video is about 300 tokens, not its bytes.
    const usage = (
      await gemini(
        ask("bestStartSeconds", [
          { inlineData: { mimeType: "video/mp4", data: "A".repeat(1_000_000) } },
        ]),
      )
    ).json;
    expect(usage).toMatchObject({ usageMetadata: { promptTokenCount: 1_200 } });
    const watched = (await gemini(ask("shots", [watch("HasaZYkwYds")]))).json;
    expect(watched).toMatchObject({ usageMetadata: { promptTokenCount: 18_000 } });
    const photo = zTakeReview.parse(
      argsOf(
        (await gemini(ask("bestStartSeconds", [shotPart({ title: "Fit", kind: "photo" })]))).json,
      ),
    );
    expect([photo.bestStartSeconds, photo.bestEndSeconds]).toEqual([null, null]);
    const bare = zTakeReview.parse(
      argsOf((await gemini(ask("bestStartSeconds", [{ text: "no shot" }]))).json),
    );
    expect(bare.feedback).toContain("this shot");
  });

  it("reads the request the way google-genai may spell it", async () => {
    const camel = {
      contents: [
        { parts: [{ fileData: { fileUri: "https://www.youtube.com/watch?v=kJQP7kiw5Fk" } }] },
      ],
      tools: [
        {},
        { functionDeclarations: [{ name: "x", parametersJsonSchema: {} }] },
        {
          functionDeclarations: [
            { name: "final_result", parametersJsonSchema: { properties: { shots: {} } } },
          ],
        },
      ],
    };
    expect(zShotPlan.parse(argsOf((await gemini(camel)).json)).format).toBe("Shoe flaunt");
    // No video to watch, a file without one, a shot that isn't JSON it knows: still an answer.
    const odd = ask("shots", [
      { fileData: {} },
      { fileData: { file_uri: "https://www.youtube.com/watch" } },
    ]);
    expect(zShotPlan.parse(argsOf((await gemini(odd)).json)).shots.length).toBeGreaterThan(0);
    const noShot = ask("inPlace", [{ text: 'The shot:\n{"nope": 1}' }, {}]);
    expect(zSceneCheck.parse(argsOf((await gemini(noShot)).json)).inPlace).toBe(true);
    expect((await gemini({ contents: [] })).status).toBe(400);
  });

  it("refuses a wrong key, an unknown ask, and a body it can't read", async () => {
    expect((await gemini(ask("shots", [watch("HasaZYkwYds")]), "wrong")).status).toBe(400);
    expect((await gemini(ask("other", [{ text: "hi" }]))).status).toBe(400);
    expect((await gemini({ contents: "nope" })).status).toBe(400);
    const broken = await fetch(`${fake.url}/v1beta/models/gemini-mock:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": KEY },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
    const empty = await fetch(`${fake.url}/v1beta/models/gemini-mock:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": KEY },
    });
    expect(empty.status).toBe(400);
  });
});

describe("the mock YouTube", () => {
  it("describes any well-formed video", async () => {
    const videos = await youtube("videos?id=HasaZYkwYds,AbCdEfGhIjK,bad");
    expect(videos.json.items?.map((item) => item.id)).toEqual(["HasaZYkwYds", "AbCdEfGhIjK"]);
    expect(shortOf("AbCdEfGhIjK").title).toBe("Your pasted short");
    expect((await youtube("videos")).json.items).toEqual([]);
  });

  it("refuses a wrong key and unknown reads, and anything else", async () => {
    expect((await youtube("videos", "wrong")).status).toBe(400);
    expect((await youtube("playlists")).status).toBe(404);
    expect((await fetch(`${fake.url}/elsewhere`)).status).toBe(404);
  });
});
