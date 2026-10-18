/**
 * The member's version of a template through the API: kept per member and template in
 * app.director_version under row-level security, and re-planned through a strict
 * stand-in for the AI service's revise route (the real one is covered in
 * apps/ai/tests/test_revise.py).
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { EMPTY_VERSION } from "@repo/contracts/api";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;
const VIDEO = "dQw4w9WgXcQ";
/** A template whose re-plan the AI service fails. */
const FAILING = "FailingPln1";
/** A template whose re-plan waits until the test lets it answer. */
const HELD = "HeldReplan1";
let heldReplan = Promise.withResolvers<void>();

let harness: Harness;
let ai: Server;
const revisions: { org: string; user: string; video: string; body: unknown }[] = [];

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** The AI service's revise route: one angle makes shot 2 a gap and moves shot 1. */
async function aiRoute(request: IncomingMessage, response: ServerResponse) {
  const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
  const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
    issuer: "api",
    audience: "ai",
  });
  const match = /^\/v1\/director\/plans\/([\w-]{11})\/revisions$/.exec(request.url ?? "");
  if (request.method !== "POST" || !match?.[1]) {
    return send(response, 404, {});
  }
  const body = await readBody(request);
  revisions.push({ org: String(payload.org), user: String(payload.sub), video: match[1], body });
  if (match[1] === HELD) {
    await heldReplan.promise;
  }
  if (match[1] === FAILING) {
    return send(response, 502, {
      defined: true,
      code: "UPSTREAM_UNAVAILABLE",
      status: 502,
      message: "UPSTREAM_UNAVAILABLE",
      data: { params: { service: "gemini" }, requestId: "r" },
    });
  }
  return send(response, 200, {
    version: {
      notes: [{ kind: "angles", note: "One angle" }],
      shots: [
        { shot: 0, where: "Right here", action: null, line: null, framing: null, camera: "front" },
      ],
      skipped: [],
      gaps: [1],
    },
    summary: "Everything's from right here now.",
  });
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  ai = createServer((request, response) => void aiRoute(request, response));
  harness = await startApi(27, { AI_URL: await listen(ai), AI_SERVICE_SECRET: SECRET });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Director" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, me: await session.rpc.user.me() };
}

const INSIDE = {
  ...EMPTY_VERSION,
  notes: [{ kind: "place" as const, note: "Inside" }],
  shots: [{ shot: 0, where: "By the window" }],
};

describe("your version of a template", () => {
  it("starts empty, keeps what the member's screen saves, and is theirs alone", async () => {
    const { session } = await signedIn();
    await expect(session.rpc.yourVersion.get({ videoId: VIDEO })).resolves.toEqual(EMPTY_VERSION);
    await session.rpc.yourVersion.save({ videoId: VIDEO, version: INSIDE });
    await expect(session.rpc.yourVersion.get({ videoId: VIDEO })).resolves.toEqual(INSIDE);
    // Saving again replaces it; a skipped shot listed twice is kept once, in order.
    const skipped = { ...INSIDE, skipped: [3, 1, 3] };
    await expect(
      session.rpc.yourVersion.save({ videoId: VIDEO, version: skipped }),
    ).resolves.toEqual({ ...INSIDE, skipped: [1, 3] });
    // Another member, in their own workspace, sees nothing of it.
    const other = await signedIn();
    await expect(other.session.rpc.yourVersion.get({ videoId: VIDEO })).resolves.toEqual(
      EMPTY_VERSION,
    );
  });

  it("refuses a version past its bounds", async () => {
    const { session } = await signedIn();
    const error = await session.rpc.yourVersion
      .save({ videoId: VIDEO, version: { ...EMPTY_VERSION, skipped: [12] } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
  });

  it("re-plans through the AI service and keeps the result", async () => {
    const { session, me } = await signedIn();
    const result = await session.rpc.yourVersion.revise({
      videoId: VIDEO,
      instruction: "one position, front camera",
      version: INSIDE,
    });
    expect(result.summary).toBe("Everything's from right here now.");
    // Python's nulls are rows the version doesn't change: left out.
    expect(result.version.shots).toEqual([{ shot: 0, where: "Right here", camera: "front" }]);
    expect(result.version.gaps).toEqual([1]);
    expect(revisions.at(-1)).toMatchObject({
      user: me.id,
      video: VIDEO,
      body: { instruction: "one position, front camera", version: INSIDE },
    });
    await expect(session.rpc.yourVersion.get({ videoId: VIDEO })).resolves.toEqual(result.version);
  });

  it("keeps what the member saved while a re-plan ran, rather than the re-plan over it", async () => {
    const { session } = await signedIn();
    heldReplan = Promise.withResolvers<void>();
    await session.rpc.yourVersion.save({ videoId: HELD, version: INSIDE });
    const asked = revisions.length;
    const replanning = session.rpc.yourVersion.revise({
      videoId: HELD,
      instruction: "one angle",
      version: INSIDE,
    });
    await expect.poll(() => revisions.length).toBe(asked + 1);
    // The member takes the chip away while Gemini works.
    await session.rpc.yourVersion.save({ videoId: HELD, version: { ...INSIDE, notes: [] } });
    heldReplan.resolve();
    const result = await replanning;
    expect(result.version.gaps).toEqual([1]);
    await expect(session.rpc.yourVersion.get({ videoId: HELD })).resolves.toEqual({
      ...INSIDE,
      notes: [],
    });
  });

  it("keeps the version as it was when the re-plan fails", async () => {
    const { session } = await signedIn();
    await session.rpc.yourVersion.save({ videoId: FAILING, version: INSIDE });
    const error = await session.rpc.yourVersion
      .revise({ videoId: FAILING, instruction: "one angle", version: INSIDE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("UPSTREAM_UNAVAILABLE");
    await expect(session.rpc.yourVersion.get({ videoId: FAILING })).resolves.toEqual(INSIDE);
  });
});
