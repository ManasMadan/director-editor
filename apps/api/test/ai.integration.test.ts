/**
 * The API's side of the AI features against a strict stand-in for the Python service:
 * it checks the per-call token the API signs, and answers the way the real service does
 * (including its error codes and its event stream). The real service is covered by its
 * own tests (apps/ai) and end to end by the web suite.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

const SECRET = `test-ai-secret-${randomUUID()}`;

interface Doc {
  id: string;
  org: string;
  title: string;
  status: string;
  error: null;
  chunkCount: number;
  summary: string | null;
  createdBy: string;
  createdAt: string;
}

let harness: Harness;
let ai: Server;
const documents: Doc[] = [];
const calls: { path: string; org: string; user: string; requestId: string | undefined }[] = [];
/** Per organization: what the next answer does. */
const behaviour = new Map<string, Mode>();
/** Organizations whose hanging answer the API stopped reading (the connection closed). */
const closed = new Set<string>();

/** A request's JSON body, as far as the stand-in reads it. */
async function body(request: IncomingMessage): Promise<{ title?: string } | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString()) as { title?: string })
    : undefined;
}

type Mode = "answer" | "budget" | "off" | "stream-error" | "down" | "drop" | "hang";
type Reply = (status: number, payload?: unknown) => void;
type Fail = (status: number, code: string, params?: Record<string, string>) => void;

/** The caller named by the token the API signed, or undefined when it doesn't verify. */
async function verifiedCaller(request: IncomingMessage) {
  try {
    const token = String(request.headers.authorization ?? "").replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      issuer: "api",
      audience: "ai",
      maxTokenAge: 120,
    });
    return { org: String(payload.org), user: String(payload.sub) };
  } catch {
    return undefined;
  }
}

/** The assistant's answer in the organization's mode: refused, broken, or streamed. */
function answer(mode: Mode, org: string, response: ServerResponse, fail: Fail) {
  if (mode === "budget") {
    return fail(429, "AI_BUDGET_EXCEEDED");
  }
  if (mode === "off") {
    return fail(404, "FEATURE_DISABLED", { feature: "assistant" });
  }
  if (mode === "down") {
    return fail(500, "INTERNAL");
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify({ event })}\n\n`);
  // The connection breaks midway (closed without ending the response), or the answer
  // never ends.
  if (mode === "drop") {
    return response.write(
      `data: ${JSON.stringify({ event: { type: "text", text: "Refunds take " } })}\n\n`,
      () => response.socket?.end(),
    );
  }
  send({ type: "text", text: "Refunds take " });
  if (mode === "hang") {
    return response.on("close", () => closed.add(org));
  }
  send({ type: "text", text: "five days." });
  if (mode === "stream-error") {
    send({ type: "error", code: "AI_RUN_LIMIT" });
    return response.end();
  }
  send({ type: "sources", sources: [{ documentId: randomUUID(), title: "Handbook" }] });
  send({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } });
  return response.end();
}

/** The documents endpoints, for the caller's organization; false for another path. */
function documentsRoute(
  route: string,
  caller: { org: string; user: string },
  input: { title?: string } | undefined,
  reply: Reply,
  fail: Fail,
) {
  const { org, user } = caller;
  if (route === "GET /v1/documents") {
    reply(
      200,
      documents.filter((d) => d.org === org),
    );
    return true;
  }
  if (route === "POST /v1/documents") {
    const doc: Doc = {
      id: randomUUID(),
      org,
      title: input?.title ?? "",
      status: "pending",
      error: null,
      chunkCount: 0,
      summary: null,
      createdBy: user,
      createdAt: new Date().toISOString(),
    };
    documents.push(doc);
    reply(201, doc);
    return true;
  }
  const remove = /^DELETE \/v1\/documents\/([0-9a-f-]{36})$/.exec(route);
  if (!remove) {
    return false;
  }
  const index = documents.findIndex((d) => d.id === remove[1] && d.org === org);
  if (index === -1) {
    fail(404, "DOCUMENT_NOT_FOUND");
  } else {
    documents.splice(index, 1);
    reply(204);
  }
  return true;
}

beforeAll(async () => {
  ai = createServer(async (request, response) => {
    const reply: Reply = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    // The service's error body: the contract's shape (packages/contracts errorResponse).
    const fail: Fail = (status, code, params = {}) =>
      reply(status, { defined: true, code, status, message: code, data: { params } });
    const caller = await verifiedCaller(request);
    if (!caller) {
      return fail(401, "UNAUTHENTICATED");
    }
    const path = new URL(request.url ?? "/", "http://ai").pathname;
    calls.push({
      path,
      ...caller,
      requestId: request.headers["x-request-id"] as string | undefined,
    });
    const input = await body(request);
    const route = `${request.method} ${path}`;

    if (route === "POST /v1/sentiment") {
      return reply(200, { label: "positive", score: 0.9, model: "fake" });
    }
    if (documentsRoute(route, caller, input, reply, fail)) {
      return;
    }
    if (route === "POST /v1/assistant/answers") {
      return answer(behaviour.get(caller.org) ?? "answer", caller.org, response, fail);
    }
    fail(404, "NOT_FOUND");
  });
  await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
  harness = await startApi(5, {
    AI_URL: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`,
    AI_SERVICE_SECRET: SECRET,
  });
});

afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => ai?.close(resolve));
});

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "AI" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, me: await session.rpc.user.me() };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
}

/** Every event of a stream, from the promise that starts it. */
async function collect(start: Promise<AsyncIterable<unknown>>) {
  const events: unknown[] = [];
  for await (const event of await start) {
    events.push(event);
  }
  return events;
}

describe("AI features", () => {
  it("calls the service as the user, in their active workspace, with the request id", async () => {
    const { session, me } = await signedIn();
    await expect(session.rpc.ai.sentiment({ text: "great" })).resolves.toEqual({
      label: "positive",
      score: 0.9,
      model: "fake",
    });
    const call = calls.at(-1);
    expect(call).toMatchObject({
      path: "/v1/sentiment",
      user: me.id,
      org: me.activeOrganizationId,
      requestId: expect.any(String),
    });
  });

  it("adds, lists and removes documents, per workspace", async () => {
    const { session } = await signedIn();
    const added = await session.rpc.ai.addDocument({ title: "Handbook", content: "Refunds…" });
    expect(added).toMatchObject({
      title: "Handbook",
      status: "pending",
      summary: null,
      createdAt: expect.any(Date),
    });
    expect((await session.rpc.ai.documents()).map((d) => d.id)).toEqual([added.id]);

    const other = await signedIn();
    expect(await other.session.rpc.ai.documents()).toEqual([]);
    await expectError(
      other.session.rpc.ai.removeDocument({ documentId: added.id }),
      "DOCUMENT_NOT_FOUND",
    );
    await session.rpc.ai.removeDocument({ documentId: added.id });
    expect(await session.rpc.ai.documents()).toEqual([]);
  });

  it("serves documents to API keys with the documents scopes, and the assistant to no key", async () => {
    const { session, me } = await signedIn();
    const reader = await session.rpc.apiKeys.create({
      name: "Reader",
      scopes: ["documents:read"],
      expiresInDays: null,
    });
    const writer = await session.rpc.apiKeys.create({
      name: "Writer",
      scopes: ["documents:read", "documents:write"],
      expiresInDays: null,
    });
    const call = (key: string, method: string, path: string, body?: unknown) =>
      fetch(`${harness.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          "x-api-key": key,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const added = await call(writer.key, "POST", "/ai/documents", { title: "FAQ", content: "…" });
    expect(added.status).toBe(200);
    const document = (await added.json()) as { id: string };
    // Acts as the key's creator, in its workspace.
    expect(calls.at(-1)).toMatchObject({ user: me.id, org: me.activeOrganizationId });

    const listed = await call(reader.key, "GET", "/ai/documents");
    expect(((await listed.json()) as { id: string }[]).map((d) => d.id)).toEqual([document.id]);
    expect((await call(reader.key, "POST", `/ai/documents/${document.id}/remove`)).status).toBe(
      403,
    );
    // Asking the assistant spends the workspace's AI budget: people only.
    expect(
      (await call(writer.key, "POST", "/ai/answers", { question: "What is in the FAQ?" })).status,
    ).toBe(403);
    expect((await call(writer.key, "POST", `/ai/documents/${document.id}/remove`)).status).toBe(
      200,
    );
    expect((await call(reader.key, "GET", "/ai/documents")).status).toBe(200);
  });

  it("members may remove only their own documents; admins any", async () => {
    const owner = await signedIn();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
    const member = await signedIn();
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: org.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    await member.session.auth("/organization/accept-invitation", {
      invitationId: new URL(invitation.data.acceptUrl).pathname.split("/").at(-1),
    });
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });

    const ownersDoc = await owner.session.rpc.ai.addDocument({ title: "Owner's", content: "x" });
    const membersDoc = await member.session.rpc.ai.addDocument({ title: "Member's", content: "x" });
    await expectError(
      member.session.rpc.ai.removeDocument({ documentId: ownersDoc.id }),
      "FORBIDDEN",
    );
    await expectError(
      member.session.rpc.ai.removeDocument({ documentId: randomUUID() }),
      "DOCUMENT_NOT_FOUND",
    );
    await member.session.rpc.ai.removeDocument({ documentId: membersDoc.id });
    const again = await member.session.rpc.ai.addDocument({
      title: "Member's again",
      content: "x",
    });
    await owner.session.rpc.ai.removeDocument({ documentId: again.id });
    expect((await owner.session.rpc.ai.documents()).map((d) => d.title)).toEqual(["Owner's"]);
  });

  it("streams an answer's events through, validated", async () => {
    const { session } = await signedIn();
    const events = await collect(session.rpc.ai.ask({ question: "Refunds?" }));
    expect(events).toEqual([
      { type: "text", text: "Refunds take " },
      { type: "text", text: "five days." },
      { type: "sources", sources: [{ documentId: expect.any(String), title: "Handbook" }] },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  it("passes on an exhausted budget, and an answer stopped midway", async () => {
    const { session, me } = await signedIn();
    const org = me.activeOrganizationId as string;
    behaviour.set(org, "budget");
    await expectError(collect(session.rpc.ai.ask({ question: "Hi?" })), "AI_BUDGET_EXCEEDED");
    behaviour.set(org, "stream-error");
    const events = await collect(session.rpc.ai.ask({ question: "Hi?" }));
    expect(events.at(-1)).toEqual({ type: "error", code: "AI_RUN_LIMIT" });
  });

  it("ends an answer whose connection breaks with an error event", async () => {
    const { session, me } = await signedIn();
    behaviour.set(me.activeOrganizationId as string, "drop");
    expect(await collect(session.rpc.ai.ask({ question: "Hi?" }))).toEqual([
      { type: "text", text: "Refunds take " },
      { type: "error", code: "UPSTREAM_UNAVAILABLE" },
    ]);
  });

  it("stops reading the service's answer when the client goes away", async () => {
    const { session, me } = await signedIn();
    const org = me.activeOrganizationId as string;
    behaviour.set(org, "hang");
    const controller = new AbortController();
    const stream = await session.rpc.ai.ask({ question: "Hi?" }, { signal: controller.signal });
    for await (const event of stream) {
      expect(event).toEqual({ type: "text", text: "Refunds take " });
      break;
    }
    controller.abort();
    await expect.poll(() => closed.has(org), { timeout: 5_000 }).toBe(true);
  });

  it("passes on what the service's error says, params included", async () => {
    const { session, me } = await signedIn();
    behaviour.set(me.activeOrganizationId as string, "off");
    const error = await collect(session.rpc.ai.ask({ question: "Hi?" })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "FEATURE_DISABLED",
      defined: true,
      data: { params: { feature: "assistant" } },
    });
  });

  it("hides the service's own failures behind UPSTREAM_UNAVAILABLE", async () => {
    const { session, me } = await signedIn();
    behaviour.set(me.activeOrganizationId as string, "down");
    await expectError(collect(session.rpc.ai.ask({ question: "Hi?" })), "UPSTREAM_UNAVAILABLE");
  });

  it("limits sentiment checks per user", async () => {
    const { session } = await signedIn();
    for (let i = 0; i < 60; i++) {
      await session.rpc.ai.sentiment({ text: "great" });
    }
    await expectError(session.rpc.ai.sentiment({ text: "great" }), "RATE_LIMITED");
  });

  it("limits questions per user", async () => {
    const { session } = await signedIn();
    for (let i = 0; i < 20; i++) {
      await collect(session.rpc.ai.ask({ question: `Q${i}?` }));
    }
    await expectError(collect(session.rpc.ai.ask({ question: "One more?" })), "RATE_LIMITED");
  });

  it("validates input before calling the service", async () => {
    const { session } = await signedIn();
    const before = calls.length;
    await expectError(session.rpc.ai.addDocument({ title: "", content: "x" }), "VALIDATION_FAILED");
    await expectError(
      collect(session.rpc.ai.ask({ question: "x".repeat(2_001) })),
      "VALIDATION_FAILED",
    );
    expect(calls.length).toBe(before);
  });

  it("needs a session", async () => {
    await expectError(createSession(harness).rpc.ai.documents(), "UNAUTHENTICATED");
  });
});
