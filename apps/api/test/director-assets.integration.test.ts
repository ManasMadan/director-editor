/**
 * Director's making tools through the API: the asset picker (a slot's images, drawn,
 * uploaded or copied from stock), the conversational editor, describing a template of
 * the member's own, and finding a thing in a camera frame. Against a stand-in for the AI
 * service that checks the per-call token and keeps each workspace's rows apart, and one
 * for Pexels and Pixabay. The real AI service is covered by its own tests
 * (apps/ai/tests/test_picker.py, test_editor.py, test_create.py).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import {
  zAssetCandidateOut,
  zAssetSlotsOut,
  zBrainstormReply,
  zDirectorPlanOut,
  zEditorReply,
  zLocated,
} from "@repo/ai-client/schemas";
import type { ShotPlan } from "@repo/contracts/api";
import { S3Storage } from "@repo/nest-common";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  startApi,
  takeOtp,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;
const VIDEO = "AssetShort1";
/** A template whose plan the AI service is still writing. */
const PENDING = "PendingOne1";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let harness: Harness;
let ai: Server;
let stock: Server;
let stockUrl = "";

function asset(id: string) {
  return {
    id,
    kind: "image",
    title: `The ${id}`,
    role: "Under the speaker, in a split screen",
    description: "A chart of twelve archetypes.",
    prompt: 'A flat black-and-white chart titled "12 ARCHETYPES".',
    sourceStartSeconds: 0,
    sourceEndSeconds: 9,
    defaultSource: "create",
    personalisable: true,
    ask: null,
    secondScreen: false,
    reference: {
      subject: "Twelve archetypes, a portrait on each row",
      composition: "Title on top, twelve rows below",
      style: "Flat infographic",
      palette: "Black and white",
      blackAndWhite: true,
      aspectRatio: "9:8",
      text: ["12 ARCHETYPES"],
      mood: "Bold",
    },
  };
}

const SHOT_PLAN: ShotPlan = {
  title: "Pen drop",
  format: "Shoe check",
  summary: "A dropped pen, a slow tilt down to the shoes, a look around.",
  audio: "music",
  durationSeconds: 9,
  shots: [
    {
      kind: "video",
      mode: "on-camera",
      title: "The drop",
      purpose: "The pen falls; the camera follows it down.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 9,
      durationSeconds: 9,
      camera: "back",
      scene: "Anywhere with a clear floor",
      sceneLandmark: null,
      framing: {
        shotSize: "close-up",
        subject: { x: 0.2, y: 0.5, width: 0.6, height: 0.4 },
        note: "Shoes fill the bottom half.",
      },
      phoneAngle: { pitch: -60, roll: 0, tolerance: 10, height: "shoulder" },
      pose: { description: "No one in frame.", keypoints: [] },
      steps: [{ atSeconds: 0, instruction: "Drop your pen.", cameraMove: "down" }],
      script: [],
    },
  ],
  assets: [],
  edits: [],
};

interface StandInPlan {
  id: string;
  org: string;
  videoId: string;
  source: "seed" | "user" | "created";
  status: "pending" | "ready";
  plan: unknown;
}
/** The workspaces' plans, as the AI service keeps them. */
const plans: StandInPlan[] = [];
type Candidate = ReturnType<typeof zAssetCandidateOut.parse>;
/** Each workspace's slots, by plan and asset: their images and the member's choice. */
const slots = new Map<string, { candidates: Candidate[]; chosenId: string | null }>();
const aiCalls: { route: string; org: string; user: string; body: Record<string, unknown> }[] = [];

function planOut(plan: StandInPlan) {
  const at = new Date().toISOString();
  return zDirectorPlanOut.parse({
    id: plan.id,
    videoId: plan.videoId,
    source: plan.source,
    status: plan.status,
    stage: plan.status === "ready" ? "ready" : "queued",
    error: null,
    plan: plan.status === "ready" ? plan.plan : null,
    model: plan.status === "ready" ? "gemini-test" : null,
    audioStatus: "none",
    audioKey: null,
    // The chart's default image is drawn; the logo's isn't anywhere yet.
    assetImages: [
      { assetId: "chart", status: "ready", objectKey: `director-assets/${plan.id}/chart.png` },
    ],
    createdAt: at,
    updatedAt: at,
  });
}

/** A ready plan of the workspace's, with a chart (its default drawn) and a logo slot. */
function readyPlan(org: string, videoId = VIDEO) {
  const plan: StandInPlan = {
    id: randomUUID(),
    org,
    videoId,
    source: "user",
    status: "ready",
    plan: { ...SHOT_PLAN, assets: [asset("chart"), asset("logo")] },
  };
  plans.push(plan);
  const chart = slotOf(org, videoId, "chart");
  chart.candidates.push(candidate("chart", { origin: "default", status: "ready" }));
  return plan;
}

function slotOf(org: string, videoId: string, assetId: string) {
  const key = `${org}/${videoId}/${assetId}`;
  const slot = slots.get(key) ?? { candidates: [], chosenId: null };
  slots.set(key, slot);
  return slot;
}

function candidate(assetId: string, fields: Partial<Candidate>): Candidate {
  return zAssetCandidateOut.parse({
    id: randomUUID(),
    assetId,
    origin: "created",
    status: "pending",
    objectKey: null,
    fileId: null,
    error: null,
    prompt: null,
    credit: null,
    createdAt: new Date().toISOString(),
    ...fields,
  });
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function failure(status: number, code: string) {
  return { status, body: { defined: true, code, status, message: code, data: { params: {} } } };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    : {};
}

async function caller(request: IncomingMessage) {
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    issuer: "api",
    audience: "ai",
    maxTokenAge: 120,
  });
  return { org: String(payload.org), user: String(payload.sub) };
}

type Answer = { status: number; body: unknown };
type Who = { org: string; user: string };

/** The asset picker's routes (apps/ai/app/picker.py), each workspace's own slots only. */
function pickerRoute(route: string, who: Who, body: Record<string, unknown>): Answer | null {
  const list = /^GET \/v1\/director\/plans\/([\w-]{11})\/assets$/.exec(route);
  if (list?.[1]) {
    const videoId = list[1];
    const own = plans.find((plan) => plan.org === who.org && plan.videoId === videoId);
    if (!own) {
      return failure(404, "DIRECTOR_PLAN_NOT_FOUND");
    }
    const assets = ["chart", "logo", "gone"].map((assetId) => {
      const slot = slotOf(who.org, videoId, assetId);
      return {
        assetId,
        prompt: `A ${assetId}`,
        candidates: slot.candidates,
        chosenId: slot.chosenId,
        history: [],
      };
    });
    return {
      status: 200,
      body: zAssetSlotsOut.parse({
        slots: assets,
        imagesUsed: 2,
        imagesPerVideo: 10,
        imagesToday: 3,
        imagesPerDay: 30,
      }),
    };
  }
  const match = /^POST \/v1\/director\/plans\/([\w-]{11})\/assets\/([\w-]+)\/(\w+)$/.exec(route);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const [, videoId, assetId, action] = match;
  const plan = plans.find((each) => each.org === who.org && each.videoId === videoId);
  if (!plan) {
    return failure(404, "DIRECTOR_PLAN_NOT_FOUND");
  }
  const slot = slotOf(who.org, videoId, assetId);
  if (action === "choice") {
    const id = body.candidateId as string | null;
    if (id !== null && !slot.candidates.some((each) => each.id === id)) {
      return failure(404, "DIRECTOR_ASSET_NOT_FOUND");
    }
    slot.chosenId = id;
    return { status: 204, body: undefined };
  }
  const made =
    action === "drawings"
      ? candidate(assetId, { prompt: String(body.prompt) })
      : candidate(assetId, {
          origin: body.origin as Candidate["origin"],
          status: "ready",
          objectKey: String(body.objectKey),
          fileId: (body.fileId as string | null) ?? null,
          credit: (body.credit as Candidate["credit"]) ?? null,
        });
  slot.candidates.push(made);
  return { status: 201, body: made };
}

/** Describing a template of the member's own (apps/ai/app/create.py). */
function createRoute(route: string, who: Who, body: Record<string, unknown>): Answer | null {
  if (route === "POST /v1/director/brainstorm") {
    const reply = { reply: "Nice. What do you drink it from?", ready: false, questionsLeft: 2 };
    return { status: 200, body: zBrainstormReply.parse(reply) };
  }
  if (route === "POST /v1/director/created") {
    const plan: StandInPlan = {
      id: randomUUID(),
      org: who.org,
      videoId: `c${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      source: "created",
      status: "pending",
      plan: null,
    };
    plans.push(plan);
    return { status: 201, body: planOut(plan) };
  }
  if (route === "PUT /v1/director/created") {
    const plan = plans.find((each) => each.org === who.org && each.videoId === body.videoId);
    if (!plan) {
      return failure(404, "DIRECTOR_PLAN_NOT_FOUND");
    }
    plan.status = "ready";
    plan.plan = body.plan;
    return { status: 200, body: planOut(plan) };
  }
  return null;
}

/** The editor and Director's eyes on the camera (apps/ai/app/editor.py, locate.py). */
function lookRoute(route: string, body: Record<string, unknown>): Answer | null {
  if (route === "POST /v1/director/editor-requests") {
    const reply = {
      actions: [],
      choices: [],
      heard: String(body.text ?? "make it black and white"),
      outcome: "applied",
      say: "Done: it's black and white now.",
    };
    return { status: 200, body: zEditorReply.parse(reply) };
  }
  if (route === "POST /v1/director/locate") {
    const found = body.target === "the window behind you";
    const located = {
      found,
      label: found ? "window" : "lamp",
      box: found ? { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } : null,
    };
    return { status: 200, body: zLocated.parse(located) };
  }
  return null;
}

async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const who = await caller(request);
  const body = await readBody(request);
  const route = `${request.method} ${request.url}`;
  aiCalls.push({ route, ...who, body });
  const plan = /^GET \/v1\/director\/plans\/([\w-]{11})$/.exec(route);
  if (plan) {
    const own = plans.find((each) => each.org === who.org && each.videoId === plan[1]);
    const answer = own
      ? { status: 200, body: planOut(own) }
      : failure(404, "DIRECTOR_PLAN_NOT_FOUND");
    return send(response, answer.status, answer.body);
  }
  const answer =
    pickerRoute(route, who, body) ?? createRoute(route, who, body) ?? lookRoute(route, body);
  const { status, body: out } = answer ?? failure(404, "NOT_FOUND");
  send(response, status, out);
}

/** Pexels' and Pixabay's search, a photo by id, and the photo files, on one port. */
function stockRoute(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", stockUrl);
  const photo = (id: number) => ({
    id,
    width: 4000,
    height: 3000,
    url: `https://www.pexels.com/photo/${id}/`,
    photographer: "Jane Doe",
    photographer_url: "https://www.pexels.com/@jane",
    alt: "A coffee cup",
    src: { large2x: `${stockUrl}/images/${id}.jpg`, medium: `${stockUrl}/images/${id}-s.jpg` },
  });
  if (url.pathname === "/v1/search") {
    return send(response, 200, { photos: [photo(1)] });
  }
  if (url.pathname === "/v1/photos/1") {
    return send(response, 200, photo(1));
  }
  if (url.pathname === "/images/1.jpg") {
    response.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length });
    return response.end(JPEG);
  }
  return send(response, 404, {});
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  ai = createServer((request, response) => {
    aiRoute(request, response).catch(() => send(response, 401, {}));
  });
  stock = createServer(stockRoute);
  stockUrl = await listen(stock);
  harness = await startApi(31, {
    ...LOCAL_STORAGE,
    AI_URL: await listen(ai),
    AI_SERVICE_SECRET: SECRET,
    PEXELS_API_KEY: "pexels-key",
    PEXELS_API_URL: stockUrl,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
  await new Promise((resolve) => stock?.close(resolve));
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Maker" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  const me = await session.rpc.user.me();
  return { session, me, org: String(me.activeOrganizationId) };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

/** A checked upload of the user's, as the worker leaves one. */
async function readyFile(userId: string, purpose: string, status = "ready") {
  const id = randomUUID();
  const db = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO files.file (id, user_id, purpose, status, filename, declared_type,
                               declared_size, content_type, size, ready_at, updated_at)
       VALUES ($1, $2, $3, $4, 'x.jpg', 'image/jpeg', 10, 'image/jpeg', 10, now(), now())`,
      [id, userId, purpose, status],
    );
  } finally {
    await db.end();
  }
  return id;
}

const callsTo = (pattern: RegExp) => aiCalls.filter((call) => pattern.test(call.route));

describe("the asset picker", () => {
  it("lists a plan's slots: the default image, the member's own images and the allowance", async () => {
    const { session, org } = await signedIn();
    const plan = readyPlan(org);
    const chart = slotOf(org, VIDEO, "chart");
    const drawn = candidate("chart", {
      status: "ready",
      objectKey: `director-assets/${plan.id}/chart/${randomUUID()}.png`,
      prompt: "A chart of my archetypes",
    });
    const clip = candidate("chart", {
      status: "ready",
      objectKey: `director-assets/${plan.id}/chart/${randomUUID()}.mp4`,
    });
    // A key the AI service answered that isn't one this image may have: never signed.
    const foreign = candidate("chart", { status: "ready", objectKey: `files/${randomUUID()}` });
    const failed = candidate("chart", { status: "failed", error: "AI_BUDGET_EXCEEDED" });
    chart.candidates.push(drawn, clip, foreign, failed);
    chart.chosenId = drawn.id;

    const assets = await session.rpc.assets.list({ videoId: VIDEO });
    expect(assets.images).toEqual({ used: 2, perVideo: 10, today: 3, perDay: 30 });
    const [first, logo, gone] = assets.slots;
    const defaultId = chart.candidates[0]?.id;
    expect(first?.defaultImage).toMatchObject({ id: defaultId, status: "ready" });
    expect(new URL(String(first?.defaultImage?.url)).pathname).toContain("chart.png");
    expect(first?.chosenId).toBe(drawn.id);
    expect(first?.images.map((image) => [image.media, image.status])).toEqual([
      ["image", "ready"],
      ["video", "ready"],
      ["image", "failed"],
      ["image", "failed"],
    ]);
    expect(new URL(String(first?.images[0]?.url)).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(first?.images[2]?.url).toBeNull();
    expect(first?.images[3]).toMatchObject({ url: null, error: "AI_BUDGET_EXCEEDED" });
    // The logo's default isn't drawn; an asset the plan no longer has has no default.
    expect(logo?.defaultImage).toBeNull();
    expect(gone?.defaultImage).toBeNull();
    expect(JSON.stringify(assets)).not.toContain("files/");
  });

  it("serves a drawn default image without an id while the AI service lists no row for it", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    slotOf(org, VIDEO, "chart").candidates = [];
    const [chart] = (await session.rpc.assets.list({ videoId: VIDEO })).slots;
    expect(chart?.defaultImage).toMatchObject({ id: null, status: "ready" });
  });

  it("lists slots with no default images while the plan is being written", async () => {
    const { session, org } = await signedIn();
    plans.push({
      id: randomUUID(),
      org,
      videoId: PENDING,
      source: "created",
      status: "pending",
      plan: null,
    });
    const { slots: listed } = await session.rpc.assets.list({ videoId: PENDING });
    expect(listed.map((slot) => slot.defaultImage)).toEqual([null, null, null]);
  });

  it("draws an image from the member's prompt, with their checked photo as its reference", async () => {
    const { session, me, org } = await signedIn();
    readyPlan(org);
    const photo = await readyFile(me.id, "director-asset-image");
    const image = await session.rpc.assets.draw({
      videoId: VIDEO,
      assetId: "logo",
      prompt: "My bakery's logo",
      instruction: "Make it round",
      baseId: randomUUID(),
      referenceFileId: photo,
      clip: true,
    });
    expect(image).toMatchObject({
      origin: "created",
      media: "image",
      status: "making",
      url: null,
      prompt: "My bakery's logo",
    });
    expect(callsTo(/\/assets\/logo\/drawings$/).at(-1)).toMatchObject({
      org,
      user: me.id,
      body: {
        prompt: "My bakery's logo",
        instruction: "Make it round",
        referenceKey: `files/${photo}`,
        demo: false,
        clip: true,
      },
    });
  });

  it("draws from the prompt alone, leaving out what the member didn't send", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    await session.rpc.assets.draw({ videoId: VIDEO, assetId: "chart", prompt: "A chart" });
    expect(callsTo(/\/assets\/chart\/drawings$/).at(-1)?.body).toEqual({
      prompt: "A chart",
      instruction: null,
      baseId: null,
      referenceKey: null,
      demo: false,
      clip: false,
    });
  });

  it("refuses a reference that isn't the member's checked image, before the AI service hears of it", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    const other = await signedIn();
    const theirs = await readyFile(other.me.id, "director-asset-image");
    const asked = aiCalls.length;
    await expectError(
      session.rpc.assets.draw({
        videoId: VIDEO,
        assetId: "chart",
        prompt: "A chart",
        referenceFileId: theirs,
      }),
      "FILE_NOT_FOUND",
    );
    expect(aiCalls.length).toBe(asked);
  });

  it("adds the member's checked upload to a slot, signed at its file's own key", async () => {
    const { session, me, org } = await signedIn();
    readyPlan(org);
    const fileId = await readyFile(me.id, "director-asset-image");
    const image = await session.rpc.assets.addUpload({ videoId: VIDEO, assetId: "logo", fileId });
    expect(image).toMatchObject({ origin: "upload", media: "image", status: "ready" });
    expect(new URL(String(image.url)).pathname).toContain(`files/${fileId}`);
    expect(callsTo(/\/assets\/logo\/images$/).at(-1)?.body).toEqual({
      origin: "upload",
      objectKey: `files/${fileId}`,
      fileId,
      credit: null,
    });
  });

  it("refuses an upload that isn't checked yet, or isn't an asset image", async () => {
    const { session, me, org } = await signedIn();
    readyPlan(org);
    const pending = await readyFile(me.id, "director-asset-image", "pending");
    const avatar = await readyFile(me.id, "avatar");
    await expectError(
      session.rpc.assets.addUpload({ videoId: VIDEO, assetId: "logo", fileId: pending }),
      "FILE_NOT_READY",
    );
    await expectError(
      session.rpc.assets.addUpload({ videoId: VIDEO, assetId: "logo", fileId: avatar }),
      "FILE_NOT_FOUND",
    );
  });

  it("chooses an image, and goes back to the default", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    const drawn = await session.rpc.assets.draw({ videoId: VIDEO, assetId: "logo", prompt: "x" });
    await expect(
      session.rpc.assets.choose({ videoId: VIDEO, assetId: "logo", imageId: drawn.id }),
    ).resolves.toEqual({ ok: true });
    expect(slotOf(org, VIDEO, "logo").chosenId).toBe(drawn.id);
    await session.rpc.assets.choose({ videoId: VIDEO, assetId: "logo", imageId: null });
    expect(slotOf(org, VIDEO, "logo").chosenId).toBeNull();
  });

  it("keeps each workspace's images its own", async () => {
    const mine = await signedIn();
    readyPlan(mine.org);
    const drawn = await mine.session.rpc.assets.draw({
      videoId: VIDEO,
      assetId: "logo",
      prompt: "Mine",
    });
    const theirs = await signedIn();
    readyPlan(theirs.org);
    const listed = await theirs.session.rpc.assets.list({ videoId: VIDEO });
    expect(JSON.stringify(listed)).not.toContain(drawn.id);
    // Choosing the other workspace's image is answered as one that doesn't exist.
    await expectError(
      theirs.session.rpc.assets.choose({ videoId: VIDEO, assetId: "logo", imageId: drawn.id }),
      "DIRECTOR_ASSET_NOT_FOUND",
    );
    expect(slotOf(mine.org, VIDEO, "logo").chosenId).toBeNull();
  });

  it("says when the plan isn't the workspace's", async () => {
    const { session } = await signedIn();
    await expectError(
      session.rpc.assets.list({ videoId: "NoSuchPlan1" }),
      "DIRECTOR_PLAN_NOT_FOUND",
    );
  });
});

describe("stock photos in the asset picker", { tags: ["files"] }, () => {
  it("searches the stock libraries, keeping their full-size links on the server", async () => {
    const { session } = await signedIn();
    const photos = await session.rpc.assets.searchStock({
      query: "coffee",
      orientation: "portrait",
    });
    expect(photos).toEqual([
      {
        provider: "pexels",
        id: "1",
        previewUrl: `${stockUrl}/images/1-s.jpg`,
        width: 4000,
        height: 3000,
        alt: "A coffee cup",
        author: "Jane Doe",
        authorUrl: "https://www.pexels.com/@jane",
        pageUrl: "https://www.pexels.com/photo/1/",
      },
    ]);
  });

  it("copies a stock photo into the slot's folder, with its credit", async () => {
    const { session, org } = await signedIn();
    const plan = readyPlan(org);
    const image = await session.rpc.assets.addStock({
      videoId: VIDEO,
      assetId: "chart",
      provider: "pexels",
      photoId: "1",
    });
    const credit = {
      provider: "pexels",
      author: "Jane Doe",
      authorUrl: "https://www.pexels.com/@jane",
      pageUrl: "https://www.pexels.com/photo/1/",
    };
    expect(image).toMatchObject({ origin: "stock", media: "image", status: "ready", credit });
    const { objectKey } = callsTo(/\/assets\/chart\/images$/).at(-1)?.body ?? {};
    expect(objectKey).toMatch(new RegExp(`^director-assets/${plan.id}/chart/[0-9a-f-]{36}\\.jpg$`));
    // The copy is ours now: stored at that key, and the link is to our storage.
    const storage = new S3Storage({
      bucket: LOCAL_STORAGE.S3_BUCKET,
      region: "us-east-1",
      endpoint: LOCAL_STORAGE.S3_ENDPOINT,
      accessKeyId: LOCAL_STORAGE.S3_ACCESS_KEY_ID,
      secretAccessKey: LOCAL_STORAGE.S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
    });
    const { url } = await storage.presignDownload(String(objectKey), { expiresInSeconds: 60 });
    const stored = await fetch(url);
    expect(Buffer.from(await stored.arrayBuffer())).toEqual(JPEG);
    expect(new URL(String(image.url)).pathname).toContain(String(objectKey));
  });

  it("copies nothing the library doesn't have", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    await expectError(
      session.rpc.assets.addStock({
        videoId: VIDEO,
        assetId: "chart",
        provider: "pexels",
        photoId: "2",
      }),
      "DIRECTOR_ASSET_NOT_FOUND",
    );
  });
});

describe("the conversational editor", () => {
  const state = { captions: "pop" as const, fixes: [], music: true, sound: true, shots: [] };

  it("passes the member's request to the AI service, as the member, and answers its reply", async () => {
    const { session, me, org } = await signedIn();
    const reply = await session.rpc.editor.ask({
      videoId: VIDEO,
      text: "make it black and white",
      audio: null,
      audioType: null,
      state,
    });
    expect(reply).toEqual({
      actions: [],
      choices: [],
      heard: "make it black and white",
      outcome: "applied",
      say: "Done: it's black and white now.",
    });
    expect(callsTo(/^POST \/v1\/director\/editor-requests$/).at(-1)).toMatchObject({
      org,
      user: me.id,
      body: { videoId: VIDEO, text: "make it black and white", state },
    });
  });

  it("takes a request said aloud, and refuses one with neither words nor a recording type", async () => {
    const { session } = await signedIn();
    const audio = "A".repeat(200);
    await session.rpc.editor.ask({
      videoId: VIDEO,
      text: null,
      audio,
      audioType: "audio/webm",
      state,
    });
    expect(callsTo(/editor-requests$/).at(-1)?.body).toMatchObject({
      audio,
      audioType: "audio/webm",
    });
    await expectError(
      session.rpc.editor.ask({ videoId: VIDEO, text: null, audio, audioType: null, state }),
      "VALIDATION_FAILED",
    );
  });
});

describe("a template of the member's own", () => {
  it("talks the idea through with the member's photos as short-lived reads", async () => {
    const { session, me } = await signedIn();
    const photo = await readyFile(me.id, "director-brief-photo");
    const reply = await session.rpc.director.brainstorm({
      text: "My morning coffee routine",
      messages: [],
      photos: [photo],
    });
    expect(reply).toEqual({
      reply: "Nice. What do you drink it from?",
      ready: false,
      questionsLeft: 2,
    });
    const asked = callsTo(/^POST \/v1\/director\/brainstorm$/).at(-1)?.body as {
      photos: { fileId: string; url: string }[];
    };
    expect(asked.photos).toHaveLength(1);
    expect(asked.photos[0]?.fileId).toBe(photo);
    expect(new URL(String(asked.photos[0]?.url)).searchParams.get("X-Amz-Expires")).toBe("1800");
  });

  it("refuses a photo that isn't the member's, before the AI service hears of it", async () => {
    const { session } = await signedIn();
    const other = await signedIn();
    const theirs = await readyFile(other.me.id, "director-brief-photo");
    const asked = aiCalls.length;
    await expectError(
      session.rpc.director.create({ text: "Coffee", messages: [], photos: [theirs] }),
      "FILE_NOT_FOUND",
    );
    expect(aiCalls.length).toBe(asked);
  });

  it("queues the template, then takes the member's changes to its shots", async () => {
    const { session } = await signedIn();
    const created = await session.rpc.director.create({
      text: "My morning coffee routine",
      messages: [{ role: "director", text: "What do you drink it from?" }],
      photos: [],
    });
    expect(created).toMatchObject({ source: "created", status: "pending", plan: null });
    const edited = await session.rpc.director.editPlan({
      videoId: created.videoId,
      plan: { ...SHOT_PLAN, title: "My coffee", assets: [] },
    });
    expect(edited).toMatchObject({ status: "ready", plan: { title: "My coffee" } });
    // Another workspace's member can't change it.
    const other = await signedIn();
    await expectError(
      other.session.rpc.director.editPlan({ videoId: created.videoId, plan: SHOT_PLAN }),
      "DIRECTOR_PLAN_NOT_FOUND",
    );
  });
});

describe("finding a thing in the camera", () => {
  const image = "A".repeat(200);

  it("answers where it is in the frame, or that it isn't there", async () => {
    const { session, org } = await signedIn();
    await expect(
      session.rpc.director.locate({ target: "the window behind you", image }),
    ).resolves.toEqual({
      found: true,
      label: "window",
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    });
    await expect(session.rpc.director.locate({ target: "the lamp", image })).resolves.toEqual({
      found: false,
      label: "lamp",
      box: null,
    });
    expect(callsTo(/^POST \/v1\/director\/locate$/).at(-1)).toMatchObject({
      org,
      body: { target: "the lamp", image },
    });
  });
});

describe("indexing without a YouTube key", () => {
  it("opens a short in the library, and says indexing a new one is off", async () => {
    const { session, org } = await signedIn();
    readyPlan(org);
    await expect(
      session.rpc.director.index({ url: `https://youtube.com/shorts/${VIDEO}` }),
    ).resolves.toMatchObject({ videoId: VIDEO, status: "ready" });
    await expect(
      session.rpc.director.index({ url: "https://youtu.be/dQw4w9WgXcQ" }),
    ).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
      data: { params: { feature: "director" } },
    });
  });
});
