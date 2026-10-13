/**
 * Workspace API keys: managing them (owners and admins), and calling the API with one,
 * over REST as a third party would: scopes, the key's workspace only, acting as its
 * creator, revocation, expiry, the per-key rate limit and what keys can never reach.
 */
import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { API_KEY_LIMIT, type ApiKeyScope, MAX_API_KEY_DAYS } from "@repo/contracts/api";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSession,
  editSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

let harness: Harness;
beforeAll(async () => {
  harness = await startApi(1);
});
afterAll(() => harness?.close());

async function signedInUser() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Key User" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, me: await session.rpc.user.me() };
}

type User = Awaited<ReturnType<typeof signedInUser>>;

/** A team workspace with an owner and a member, both with it active. */
async function team() {
  const owner = await signedInUser();
  const member = await signedInUser();
  const org = await owner.session.auth<{ id: string }>("/organization/create", {
    name: "Team",
    slug: `team-${randomUUID().slice(0, 8)}`,
  });
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
  await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
  return { owner, member, orgId: org.body.id };
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
  return error as ORPCError<string, { params?: Record<string, unknown> }>;
}

async function newKey(user: User, scopes: ApiKeyScope[] = ["todos:read", "todos:write"]) {
  return user.session.rpc.apiKeys.create({ name: "CI", scopes, expiresInDays: null });
}

/** A REST call the way a third party makes it: the key, no cookies, no origin. */
async function rest(key: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${harness.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(key !== null && { "x-api-key": key }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown> & {
      code?: string;
      data?: { params?: Record<string, unknown> };
    },
  };
}

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

describe("managing keys", () => {
  it("shows a new key once, stores only its hash and records who made it", async () => {
    const user = await signedInUser();
    const { apiKey, key } = await user.session.rpc.apiKeys.create({
      name: "  Deploy bot  ",
      scopes: ["todos:read"],
      expiresInDays: 30,
    });
    expect(key).toMatch(/^bp_[A-Za-z0-9]{64}$/);
    expect(apiKey).toMatchObject({
      name: "Deploy bot",
      start: key.slice(0, 6),
      scopes: ["todos:read"],
      createdBy: { id: user.me.id, name: "Key User" },
      lastUsedAt: null,
    });
    const days = ((apiKey.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const listed = await user.session.rpc.apiKeys.list();
    expect(listed).toEqual([apiKey]);
    expect(JSON.stringify(listed)).not.toContain(key);

    const [row] = await query<{ key: string; reference_id: string }>(
      "SELECT key, reference_id FROM auth.api_key WHERE id = $1",
      [apiKey.id],
    );
    expect(row?.key).not.toContain(key.slice(3));
    expect(row?.reference_id).toBe(user.me.activeOrganizationId);
    const events = await query<{
      name: string;
      actor_id: string;
      org_id: string;
      payload: unknown;
    }>("SELECT name, actor_id, org_id, payload FROM app.outbox_event WHERE key = $1", [apiKey.id]);
    expect(events).toEqual([
      {
        name: "org.api_key_created.v1",
        actor_id: user.me.id,
        org_id: user.me.activeOrganizationId,
        payload: { apiKeyId: apiKey.id, name: "Deploy bot", scopes: ["todos:read"] },
      },
    ]);
  });

  it("validates the name, scopes and expiry", async () => {
    const { session } = await signedInUser();
    const create = (input: Record<string, unknown>) =>
      session.rpc.apiKeys.create({
        name: "Key",
        scopes: ["todos:read"],
        expiresInDays: null,
        ...input,
      } as never);
    for (const input of [
      { name: "   " },
      { name: "x".repeat(65) },
      { scopes: [] },
      { scopes: ["todos:read", "todos:read"] },
      { scopes: ["billing:write"] },
      { expiresInDays: 7 },
    ]) {
      await expectError(create(input), "VALIDATION_FAILED");
    }
  });

  it("needs a recent sign-in to create one, so a stolen session can't leave a key behind", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });
    await expectError(newKey({ session } as User), "FRESH_SESSION_REQUIRED");
    // Managing existing ones doesn't.
    await expect(session.rpc.apiKeys.list()).resolves.toEqual([]);
  });

  it("expires every key: the old null means the longest lifetime", async () => {
    const { session } = await signedInUser();
    const { apiKey } = await newKey({ session } as User);
    const days = ((apiKey.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(MAX_API_KEY_DAYS - 1);
    expect(days).toBeLessThanOrEqual(MAX_API_KEY_DAYS);
  });

  it("is for owners and admins only", async () => {
    const { member } = await team();
    await expectError(member.session.rpc.apiKeys.list(), "FORBIDDEN");
    await expectError(newKey(member), "FORBIDDEN");
  });

  it("revokes a key at once, and only in its own workspace", async () => {
    const user = await signedInUser();
    const other = await signedInUser();
    const { apiKey, key } = await newKey(user);
    expect((await rest(key, "GET", "/todos")).status).toBe(200);

    await expectError(other.session.rpc.apiKeys.revoke({ id: apiKey.id }), "API_KEY_NOT_FOUND");
    expect((await rest(key, "GET", "/todos")).status).toBe(200);

    await user.session.rpc.apiKeys.revoke({ id: apiKey.id });
    expect((await rest(key, "GET", "/todos")).status).toBe(401);
    expect(await user.session.rpc.apiKeys.list()).toEqual([]);
    await expectError(user.session.rpc.apiKeys.revoke({ id: apiKey.id }), "API_KEY_NOT_FOUND");
    const [event] = await query<{ name: string; payload: unknown }>(
      "SELECT name, payload FROM app.outbox_event WHERE key = $1 AND name = 'org.api_key_revoked.v1'",
      [apiKey.id],
    );
    expect(event?.payload).toEqual({ apiKeyId: apiKey.id, name: "CI" });
  });

  it("reads what's stored about a key defensively: nothing malformed grants anything", async () => {
    const user = await signedInUser();
    const { apiKey, key } = await newKey(user);
    // A row edited by hand, or written by an older version: no name or prefix, permissions
    // that aren't JSON, and a creator that isn't there.
    await query(
      `UPDATE auth.api_key SET name = NULL, start = NULL, permissions = 'not json',
         metadata = $2 WHERE id = $1`,
      [apiKey.id, JSON.stringify({ createdBy: randomUUID() })],
    );
    const [listed] = await user.session.rpc.apiKeys.list();
    expect(listed).toMatchObject({
      id: apiKey.id,
      name: "",
      start: "",
      scopes: [],
      createdBy: null,
    });
    // Its creator isn't a member anywhere, so it acts as nobody.
    expect((await rest(key, "GET", "/todos")).status).toBe(401);

    // Permissions of the wrong shape, and metadata that names no creator.
    await query("UPDATE auth.api_key SET permissions = $2, metadata = '{}' WHERE id = $1", [
      apiKey.id,
      JSON.stringify({ todos: "read" }),
    ]);
    expect((await user.session.rpc.apiKeys.list())[0]).toMatchObject({
      scopes: [],
      createdBy: null,
    });
    expect((await rest(key, "GET", "/todos")).status).toBe(401);

    await user.session.rpc.apiKeys.revoke({ id: apiKey.id });
    const [event] = await query<{ payload: unknown }>(
      "SELECT payload FROM app.outbox_event WHERE key = $1 AND name = 'org.api_key_revoked.v1'",
      [apiKey.id],
    );
    expect(event?.payload).toEqual({ apiKeyId: apiKey.id, name: "" });
  });

  it(`stops at ${API_KEY_LIMIT} keys per workspace`, async () => {
    const user = await signedInUser();
    for (let i = 0; i < API_KEY_LIMIT; i++) {
      await newKey(user);
    }
    const error = await expectError(newKey(user), "API_KEY_LIMIT_REACHED");
    expect(error.data?.params).toEqual({ limit: API_KEY_LIMIT });
  });

  it("doesn't serve the key plugin's own endpoints", async () => {
    const user = await signedInUser();
    for (const path of ["/api-key/create", "/api-key/list", "/api-key/update", "/api-key/delete"]) {
      const { status } = await user.session.auth(path, { name: "Sneaky" });
      expect(status, path).toBe(404);
    }
    const response = await fetch(`${harness.baseUrl}/api/auth/api-key/get?id=${randomUUID()}`);
    expect(response.status).toBe(404);
  });

  it("goes with its workspace when the workspace is deleted", async () => {
    const { owner, orgId } = await team();
    const { key } = await newKey(owner);
    await owner.session.auth("/organization/delete", { organizationId: orgId });
    expect(await query("SELECT 1 FROM auth.api_key WHERE reference_id = $1", [orgId])).toEqual([]);
    expect((await rest(key, "GET", "/todos")).status).toBe(401);
  });
});

describe("calling the API with a key", () => {
  it("acts in the key's workspace, as the person who created it", async () => {
    const { owner, orgId } = await team();
    await owner.session.rpc.todo.create({ title: "Team todo" });
    const { key } = await newKey(owner);
    // The session moves to the personal workspace; the key stays with the team.
    await owner.session.auth("/organization/set-active", {
      organizationId: (
        await query<{ organization_id: string }>(
          "SELECT organization_id FROM auth.member WHERE user_id = $1 AND organization_id <> $2",
          [owner.me.id, orgId],
        )
      )[0]?.organization_id,
    });

    const listed = await rest(key, "GET", "/todos");
    expect(listed.status).toBe(200);
    expect((listed.body.items as { title: string }[]).map((todo) => todo.title)).toEqual([
      "Team todo",
    ]);

    const created = await rest(key, "POST", "/todos", { title: "From CI" });
    expect(created.status).toBe(201);
    const [event] = await query<{ actor_id: string; org_id: string }>(
      "SELECT actor_id, org_id FROM app.outbox_event WHERE name = 'todo.created.v1' AND key = $1",
      [created.body.id],
    );
    expect(event).toEqual({ actor_id: owner.me.id, org_id: orgId });
    expect((await owner.session.rpc.todo.list({})).items).toEqual([]);
  });

  it("works over the RPC protocol too", async () => {
    const user = await signedInUser();
    await user.session.rpc.todo.create({ title: "Mine" });
    const { key } = await newKey(user, ["todos:read"]);
    const response = await fetch(`${harness.baseUrl}/rpc/todo/list`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("Mine");
  });

  it("needs the scope the call asks for", async () => {
    const user = await signedInUser();
    const { key } = await newKey(user, ["todos:read"]);
    expect((await rest(key, "GET", "/todos")).status).toBe(200);
    const refused = await rest(key, "POST", "/todos", { title: "Not allowed" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("API_KEY_SCOPE_MISSING");
    expect(refused.body.data?.params).toEqual({ scope: "todos:write" });
    expect((await user.session.rpc.todo.list({})).items).toEqual([]);
  });

  it("can't reach anything that isn't open to keys", async () => {
    const user = await signedInUser();
    const { key } = await newKey(user, ["todos:read", "todos:write", "audit:read"]);
    // Account settings: keys never become a session.
    expect((await rest(key, "GET", "/me")).status).toBe(401);
    // Workspace settings without a key scope: billing, webhooks, the keys themselves.
    for (const path of ["/billing", "/webhooks/endpoints", "/api-keys"]) {
      const response = await rest(key, "GET", path);
      expect(response.status, path).toBe(403);
      expect(response.body.code, path).toBe("FORBIDDEN");
    }
  });

  it("refuses unknown, expired and malformed keys", async () => {
    const user = await signedInUser();
    const { apiKey, key } = await newKey(user);
    for (const bad of [`bp_${"x".repeat(64)}`, "", "not a key"]) {
      expect((await rest(bad, "GET", "/todos")).status, bad).toBe(401);
    }
    await query("UPDATE auth.api_key SET expires_at = now() - interval '1 second' WHERE id = $1", [
      apiKey.id,
    ]);
    const expired = await rest(key, "GET", "/todos");
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("UNAUTHENTICATED");
  });

  it("follows its creator's membership and role", async () => {
    const { owner, member, orgId } = await team();
    // The owner makes the member an admin, who creates a key, then is demoted and removed.
    await owner.session.auth("/organization/update-member-role", {
      memberId: (
        await query<{ id: string }>(
          "SELECT id FROM auth.member WHERE user_id = $1 AND organization_id = $2",
          [member.me.id, orgId],
        )
      )[0]?.id,
      role: "admin",
      organizationId: orgId,
    });
    const { key } = await newKey(member, ["todos:read", "audit:read"]);
    expect((await rest(key, "GET", "/audit")).status).toBe(200);

    await owner.session.auth("/organization/update-member-role", {
      memberId: (
        await query<{ id: string }>(
          "SELECT id FROM auth.member WHERE user_id = $1 AND organization_id = $2",
          [member.me.id, orgId],
        )
      )[0]?.id,
      role: "member",
      organizationId: orgId,
    });
    // A member can't read the audit log, so neither can their key.
    expect((await rest(key, "GET", "/audit")).status).toBe(403);
    expect((await rest(key, "GET", "/todos")).status).toBe(200);

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    expect((await rest(key, "GET", "/todos")).status).toBe(401);
  });

  it("is rate limited per key, and records when it was last used", async () => {
    const user = await signedInUser();
    const { apiKey, key } = await newKey(user);
    const other = await newKey(user);
    await query("UPDATE auth.api_key SET rate_limit_max = 3 WHERE id = $1", [apiKey.id]);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await rest(key, "GET", "/todos")).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await rest(key, "GET", "/todos");
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.body.data?.params?.retryAfterSeconds).toBeGreaterThan(0);
    // Another key of the same workspace has its own allowance.
    expect((await rest(other.key, "GET", "/todos")).status).toBe(200);

    const [listed] = (await user.session.rpc.apiKeys.list()).filter((k) => k.id === apiKey.id);
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("is documented per operation in the OpenAPI document", async () => {
    const spec = (await (await fetch(`${harness.baseUrl}/api/v1/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { security: unknown; description?: string }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(spec.components.securitySchemes.apiKey).toEqual({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
    expect(spec.paths["/todos"]?.get?.security).toEqual([{ session: [] }, { apiKey: [] }]);
    expect(spec.paths["/todos"]?.post?.description).toContain("`todos:write`");
    expect(spec.paths["/me"]?.get?.security).toEqual([{ session: [] }]);
    expect(spec.paths["/api-keys"]?.post?.security).toEqual([{ session: [] }]);
  });
});
