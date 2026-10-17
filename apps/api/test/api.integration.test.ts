/**
 * The API's security and behaviour guarantees, against the real app, database and Redis.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { ORPCError } from "@orpc/client";
import { ORGANIZATION_LIMIT } from "@repo/contracts/auth";
import { orgIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { realtimeChannel } from "@repo/contracts/realtime";
import { queuePrefix } from "@repo/jobs";
import { AppError, S3Storage } from "@repo/nest-common";
import { eventually } from "@repo/testing/eventually";
import { totp } from "@repo/testing/totp";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publishRealtime } from "../src/realtime";
import {
  createSession,
  editSession,
  expireOtps,
  type Harness,
  LOCAL_STORAGE,
  newEmail,
  newPassword,
  queuedNotification,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

let harness: Harness;
const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";

beforeAll(async () => {
  harness = await startApi(13, {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    MINIMUM_CLIENT_VERSION: "2.0.0",
    ...LOCAL_STORAGE,
  });
});
afterAll(() => harness?.close());

/** Signs up and verifies a new user; returns their session. */
async function signedInUser(locale = "en") {
  const session = createSession(harness, { locale });
  const email = newEmail();
  const password = newPassword();
  await session.auth("/sign-up/email", { email, password, name: "Test User" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email, password };
}

/**
 * Adds a member to a workspace straight in the database: through the API a workspace
 * has one member, its owner, so nobody can be invited.
 */
async function addMember(organizationId: string, userId: string) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
  await client.connect();
  try {
    await client.query(
      "INSERT INTO auth.member (organization_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())",
      [organizationId, userId],
    );
  } finally {
    await client.end();
  }
}

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  const orpcError = error as ORPCError<string, { issues?: unknown; params?: unknown }>;
  expect(orpcError.code).toBe(code);
  return orpcError;
}

describe("error responses", () => {
  const send = (path: string, init: RequestInit = {}) => fetch(`${harness.baseUrl}${path}`, init);
  const json = (body: string, type = "application/json") => ({
    method: "POST",
    headers: { "content-type": type },
    body,
  });

  it.each([
    ["a malformed JSON body", "/api/v1/shorts/lookup", json("{bad"), 400, "BAD_REQUEST"],
    ["an unknown route under /api/v1", "/api/v1/nope", {}, 404, "NOT_FOUND"],
    ["an unknown route anywhere else", "/v1/me", {}, 404, "NOT_FOUND"],
    [
      "the wrong media type",
      "/api/v1/shorts/lookup",
      json("x", "text/plain"),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    [
      "a raw route without a session",
      `/api/v1/files/${randomUUID()}/content`,
      {},
      401,
      "UNAUTHENTICATED",
    ],
    ["no session on a procedure", "/api/v1/me", {}, 401, "UNAUTHENTICATED"],
  ])("answers %s in the contract's shape", async (_case, path, init, status, code) => {
    const response = await send(path, init as RequestInit);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      code,
      status,
      message: expect.any(String),
      data: { params: {}, requestId: expect.any(String) },
    });
  });

  it("tells an outdated app to update, with a fitting status", async () => {
    const outdated = await send("/api/v1/me", { headers: { "x-app-version": "1.0.0" } });
    expect(outdated.status).toBe(400);
    expect(((await outdated.json()) as { code: string }).code).toBe("CLIENT_OUTDATED");
  });

  it("refuses, outside production, to answer a code the procedure's contract doesn't declare", async () => {
    const { session } = await signedInUser();
    const { ShortsService } = await import("../src/modules/shorts");
    const shorts = harness.app.get(ShortsService);
    // A code the shorts contract has no business returning.
    const reactions = vi
      .spyOn(shorts, "reactionsOf")
      .mockRejectedValueOnce(new AppError("INVALID_SIGNATURE"));
    await expectError(session.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" }), "INTERNAL");
    reactions.mockRestore();
  });

  it("gives better-auth's errors the same envelope, keeping their codes", async () => {
    const response = await send("/api/auth/sign-in/email", json(JSON.stringify({ email: "x" })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: expect.any(String),
      status: 400,
      message: expect.any(String),
      data: { params: {}, requestId: expect.any(String) },
    });
  });
});

describe("request bodies", () => {
  const post = (path: string, type: string, body: BodyInit) =>
    fetch(`${harness.baseUrl}${path}`, { method: "POST", headers: { "content-type": type }, body });

  /**
   * The status for a request announcing a body of `bytes`: sends only the headers and
   * waits, so a refusal by length alone shows (nothing is read or parsed).
   */
  function statusFor(path: string, bytes: number, type = "application/json") {
    return new Promise<number>((resolve, reject) => {
      const request = http.request(`${harness.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": type, "content-length": bytes },
      });
      request.on("response", (response) => {
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
      request.on("error", reject);
      request.flushHeaders();
    });
  }

  it("refuses an oversized body before any procedure or auth check runs", async () => {
    const big = 2 * 1024 * 1024;
    expect(await statusFor("/rpc/shorts/lookup", big)).toBe(413);
    expect(await statusFor("/api/v1/shorts/lookup", big)).toBe(413);
    // 100 MB of text, unauthenticated: refused from the headers, never read.
    expect(await statusFor("/rpc/shorts/lookup", 100 * 1024 * 1024, "text/plain")).toBe(415);
  });

  it("accepts only JSON on the API routes", async () => {
    for (const type of [
      "text/plain",
      "application/octet-stream",
      "multipart/form-data; boundary=x",
    ]) {
      expect((await post("/rpc/shorts/lookup", type, "x".repeat(1024))).status, type).toBe(415);
      expect((await post("/api/v1/shorts/lookup", type, "x".repeat(1024))).status, type).toBe(415);
    }
  });

  it("still serves JSON calls", async () => {
    const response = await post(
      "/rpc/shorts/lookup",
      "application/json",
      JSON.stringify({ json: { url: "https://youtube.com/shorts/dQw4w9WgXcQ" } }),
    );
    // Unauthenticated, but parsed and routed: the procedure answered.
    expect(response.status).toBe(401);
  });
});

describe("Google sign-in", () => {
  it("is on when configured, and sends the browser to Google", async () => {
    const session = createSession(harness);
    expect((await session.rpc.system.info()).features.google).toBe(true);
    const started = await session.auth<{ url: string; redirect: boolean }>("/sign-in/social", {
      provider: "google",
      callbackURL: process.env.WEB_URL,
    });
    expect(started.status).toBe(200);
    expect(new URL(started.body.url).origin).toBe("https://accounts.google.com");
    expect(new URL(started.body.url).searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
  });
});

describe("profile settings", () => {
  it("saves a known language and time zone, and refuses anything else", async () => {
    const { session } = await signedInUser();
    expect(
      (await session.auth("/update-user", { locale: "en", timezone: "Asia/Tokyo" })).status,
    ).toBe(200);
    expect(await session.rpc.user.me()).toMatchObject({ locale: "en", timezone: "Asia/Tokyo" });
    for (const change of [{ locale: "xx" }, { timezone: "Mars/Olympus" }]) {
      const refused = await session.auth<{ code?: string }>("/update-user", change);
      expect(refused.status, JSON.stringify(change)).toBe(400);
      expect(refused.body.code).toBe("VALIDATION_FAILED");
    }
    expect(await session.rpc.user.me()).toMatchObject({ locale: "en", timezone: "Asia/Tokyo" });
  });
});

describe("an account without a workspace", () => {
  it("can still sign in, and is told to pick one for workspace data", async () => {
    const { session, email, password } = await signedInUser();
    const { activeOrganizationId } = await session.rpc.user.me();
    expect(
      (await session.auth("/organization/delete", { organizationId: activeOrganizationId })).status,
    ).toBe(200);
    await session.auth("/sign-out");
    expect((await session.auth("/sign-in/email", { email, password })).status).toBe(200);
    expect((await session.rpc.user.me()).activeOrganizationId).toBeNull();
    await expectError(
      session.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" }),
      "NO_ACTIVE_ORGANIZATION",
    );
  });
});

describe("a session cookie that names no session", () => {
  it("is treated as signed out, on auth routes as on the API", async () => {
    const session = createSession(harness);
    session.useCookies(new Map([["better-auth.session_token", "not-a-session.signature"]]));
    expect((await session.authGet<unknown>("/get-session")) ?? null).toBeNull();
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");
  });
});

describe("sign-up and verification", () => {
  it("ignores a picture sent with sign-up: only the avatar upload sets one", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", {
      email,
      password: newPassword(),
      name: "Pic",
      image: "https://evil.example/tracker.png",
    });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });
    expect((await session.rpc.user.me()).image).toBeNull();
  });

  it("sends one address at most ten codes an hour, whichever endpoint asks", async () => {
    const session = createSession(harness);
    const email = newEmail();
    const password = newPassword();
    await session.auth("/sign-up/email", { email, password, name: "Codes" });
    // Eleven requests for a code, within each endpoint's per-address limit: the sign-up,
    // three resets, five verification codes and two sign-ins to the unverified account.
    for (let i = 0; i < 3; i++) {
      await session.auth("/forget-password/email-otp", { email });
    }
    for (let i = 0; i < 5; i++) {
      await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    }
    for (let i = 0; i < 2; i++) {
      await session.auth("/sign-in/email", { email, password });
    }
    // Codes go out in the background: once the limit has counted all eleven (the last
    // one refused), every code that will be queued has been.
    await eventually(
      () => harness.redis.get(`{rl:email:codesPerRecipient}:${email.toLowerCase()}`),
      (count) => count === "11",
    );
    for (let i = 0; i < 10; i++) {
      await takeOtp(harness, email);
    }
    expect(await queuedNotification(harness, "auth.otp", email)).toBeUndefined();
  });

  it("issues no session until the email is verified, and queues the code in the browser's language", async () => {
    const session = createSession(harness, { locale: "en-GB,en;q=0.9" });
    const email = newEmail();
    const signUp = await session.auth<{ token: string | null }>("/sign-up/email", {
      email,
      password: newPassword(),
      name: "Lucía",
    });
    expect(signUp.status).toBe(200);
    expect(signUp.body.token).toBeNull();
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");

    const code = await takeOtp(harness, email);
    expect(code).toMatchObject({ locale: "en", purpose: "email-verification" });
    expect(code.otp).toMatch(/^\d{6}$/);

    await session.auth("/email-otp/verify-email", { email, otp: code.otp });
    const me = await session.rpc.user.me();
    expect(me).toMatchObject({ email, locale: "en" });
    // Their personal workspace, made at sign-up.
    const [personal, ...others] =
      await session.authGet<{ id: string; slug: string }[]>("/organization/list");
    expect(others).toEqual([]);
    expect(personal?.slug).toBe(`personal-${me.id}`);
    expect(me.activeOrganizationId).toBe(personal?.id);
  });
});

describe("session revocation", () => {
  it("rejects a signed-out session's cookie on the very next request", async () => {
    const { session } = await signedInUser();
    const stolen = session.cookies();
    await session.auth("/sign-out");

    const attacker = createSession(harness);
    attacker.useCookies(stolen);
    await expectError(attacker.rpc.user.me(), "UNAUTHENTICATED");
  });

  it("kills other sessions when a device is revoked", async () => {
    const { session: laptop, email, password } = await signedInUser();
    const phone = createSession(harness);
    await phone.auth("/sign-in/email", { email, password });
    await expect(phone.rpc.user.me()).resolves.toMatchObject({ email });

    await laptop.auth("/revoke-other-sessions");
    await expectError(phone.rpc.user.me(), "UNAUTHENTICATED");
    await expect(laptop.rpc.user.me()).resolves.toMatchObject({ email });
  });

  it("signs out every device when the password is reset", async () => {
    const { session, email } = await signedInUser();
    const anonymous = createSession(harness);
    await anonymous.auth("/email-otp/request-password-reset", { email });
    const { otp, purpose } = await takeOtp(harness, email);
    expect(purpose).toBe("forget-password");
    const reset = await anonymous.auth("/email-otp/reset-password", {
      email,
      otp,
      password: newPassword(),
    });
    expect(reset.status).toBe(200);
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");
  });

  it("limits sign-in attempts per client", async () => {
    const attacker = createSession(harness);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await attacker.auth("/sign-in/email", { email: newEmail(), password: "wrong-password-1" }))
          .status,
      );
    }
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("limits password attempts per account, however many addresses they come from", async () => {
    const { email, password } = await signedInUser();
    // Each attempt from a new session: a new client address, as a forged or rotated
    // X-Forwarded-For would give, so the per-address limit never applies.
    const attempt = (guess: string) =>
      createSession(harness).auth("/sign-in/email", { email, password: guess });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await attempt(`wrong-password-${i}`)).status);
    }
    expect(statuses.every((status) => status === 401)).toBe(true);
    const locked = await attempt(password);
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({ code: "RATE_LIMITED" });
    // Other accounts are untouched.
    const other = await signedInUser();
    expect(
      (
        await createSession(harness).auth("/sign-in/email", {
          email: other.email,
          password: other.password,
        })
      ).status,
    ).toBe(200);
  });
});

describe("account security", () => {
  it("keeps two-factor backup codes encrypted at rest, and each works once", async () => {
    const { session, email, password } = await signedInUser();
    const enabled = await session.auth<{ totpURI: string; backupCodes: string[] }>(
      "/two-factor/enable",
      { password },
    );
    expect(enabled.status).toBe(200);
    const secret = new URL(enabled.body.totpURI).searchParams.get("secret") ?? "";
    expect((await session.auth("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(
      200,
    );

    // What's stored reveals none of the codes.
    const db = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await db.connect();
    const stored = await db
      .query<{ backup_codes: string }>(
        `SELECT t.backup_codes FROM auth.two_factor t JOIN auth."user" u ON u.id = t.user_id WHERE u.email = $1`,
        [email],
      )
      .finally(() => db.end());
    const [code, ...others] = enabled.body.backupCodes;
    expect(code).toMatch(/^[\w-]{11}$/);
    for (const backup of enabled.body.backupCodes) {
      expect(stored.rows[0]?.backup_codes).not.toContain(backup);
    }

    const again = createSession(harness);
    const signIn = await again.auth<{ twoFactorRedirect?: boolean }>("/sign-in/email", {
      email,
      password,
    });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await again.auth("/two-factor/verify-backup-code", { code })).status).toBe(200);
    expect(await again.rpc.user.me()).toMatchObject({ email });

    const replay = createSession(harness);
    await replay.auth("/sign-in/email", { email, password });
    expect((await replay.auth("/two-factor/verify-backup-code", { code })).status).not.toBe(200);
    expect(others).toHaveLength(9);
  });

  it("changing the password emails a security alert to the account", async () => {
    const { session, email, password } = await signedInUser();
    const changed = await session.auth("/change-password", {
      currentPassword: password,
      newPassword: newPassword(),
    });
    expect(changed.status).toBe(200);
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data).toMatchObject({
      event: "password-changed",
      securityUrl: expect.stringContaining("/settings/security"),
    });
  });

  it("writes the alert with the audit entry, not straight to Redis, so it can't be lost", async () => {
    const { session, email, password } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    await session.auth("/change-password", {
      currentPassword: password,
      newPassword: newPassword(),
    });
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client
      .query<{ name: string; payload: { notification?: { to: { email: string } } } }>(
        `SELECT name, payload FROM app.outbox_event
          WHERE actor_id = $1::uuid AND name IN ('auth.password_changed.v1', 'notification.requested.v1')
          ORDER BY id`,
        [userId],
      )
      .finally(() => client.end());
    expect(rows.map((row) => row.name)).toEqual([
      "auth.password_changed.v1",
      "notification.requested.v1",
    ]);
    expect(rows[1]?.payload.notification?.to.email).toBe(email);
    // Nothing went to the queue directly.
    const queue = new Queue("notifications-critical", {
      connection: harness.redis,
      prefix: queuePrefix("notifications-critical"),
    });
    const queued = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
      (job) =>
        job.data.payload.template === "auth.security-alert" && job.data.payload.to.email === email,
    );
    await queue.close();
    expect(queued).toEqual([]);
  });

  it("a change still succeeds when its alert can't be recorded", async () => {
    const { session, password } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    // Another transaction holds the outbox, so the alert's transaction times out.
    const holder = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE app.outbox_event IN SHARE MODE");
    const changed = await session
      .auth("/change-password", { currentPassword: password, newPassword: newPassword() })
      .finally(() => holder.query("ROLLBACK"));
    const { rows } = await holder
      .query(
        "SELECT 1 FROM app.outbox_event WHERE actor_id = $1::uuid AND name = 'auth.password_changed.v1'",
        [userId],
      )
      .finally(() => holder.end());
    expect(changed.status).toBe(200);
    expect(rows).toEqual([]);
  });

  it("a failed change sends no alert", async () => {
    const { session, email } = await signedInUser();
    const failed = await session.auth("/change-password", {
      currentPassword: "wrong-password",
      newPassword: newPassword(),
    });
    expect(failed.status).toBe(400);
    // An alert is recorded before the request answers: there's nothing to wait for.
    expect(await queuedNotification(harness, "auth.security-alert", email)).toBeUndefined();
  });

  it("changing the email needs codes from both addresses and alerts the old one", async () => {
    const { session, email, password } = await signedInUser();
    const next = newEmail();

    // Without the current address's code, nothing is sent to the new one.
    const blocked = await session.auth("/email-otp/request-email-change", { newEmail: next });
    expect(blocked.status).toBe(400);

    await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    const current = await takeOtp(harness, email);
    expect(
      (await session.auth("/email-otp/request-email-change", { newEmail: next, otp: current.otp }))
        .status,
    ).toBe(200);
    const confirmation = await takeOtp(harness, next);
    expect(confirmation.purpose).toBe("change-email");
    expect(
      (await session.auth("/email-otp/change-email", { newEmail: next, otp: confirmation.otp }))
        .status,
    ).toBe(200);

    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data).toMatchObject({ event: "email-changed", newEmail: next });
    expect((await session.rpc.user.me()).email).toBe(next);
    // The new address signs in; the old one no longer exists.
    const fresh = createSession(harness);
    expect((await fresh.auth("/sign-in/email", { email: next, password })).status).toBe(200);
    expect((await createSession(harness).auth("/sign-in/email", { email, password })).status).toBe(
      401,
    );
  });

  it("the link-based email change is disabled", async () => {
    const { session } = await signedInUser();
    const response = await session.auth("/change-email", { newEmail: newEmail() });
    expect(response.status).not.toBe(200);
  });
});

describe("time limits", () => {
  it("an expired verification code is refused, and a new one works", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Late" });
    const { otp } = await takeOtp(harness, email);
    await expireOtps(harness, email);
    const late = await session.auth<{ code: string }>("/email-otp/verify-email", { email, otp });
    expect(late.status).toBe(400);
    expect(late.body.code).toBe("OTP_EXPIRED");

    await session.auth("/email-otp/send-verification-otp", { email, type: "email-verification" });
    const fresh = await takeOtp(harness, email);
    expect((await session.auth("/email-otp/verify-email", { email, otp: fresh.otp })).status).toBe(
      200,
    );
  });

  it("a session older than the fresh window can't list devices or add passkeys", async () => {
    const { session, email } = await signedInUser();
    expect((await session.authGet<unknown[]>("/list-sessions")).length).toBe(1);
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });

    const devices = await session.authGet<{ code: string }>("/list-sessions");
    expect(devices.code).toBe("SESSION_NOT_FRESH");
    const passkey = await session.authGet<{ code: string }>("/passkey/generate-register-options");
    expect(passkey.code).toBe("SESSION_NOT_FRESH");
    // Everyday use is unaffected.
    expect((await session.rpc.user.me()).email).toBe(email);
  });

  it("a session past its expiry is rejected", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await expectError(session.rpc.user.me(), "UNAUTHENTICATED");
  });
});

describe("organizations and the audit trail", () => {
  /** Outbox rows (events) for an aggregate key, read as the database superuser. */
  async function outbox(where: string, params: unknown[]) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    try {
      const { rows } = await client.query<{
        name: string;
        payload: Record<string, unknown>;
        org_id: string | null;
        actor_id: string | null;
      }>(
        `SELECT name, payload, org_id, actor_id FROM app.outbox_event WHERE ${where} ORDER BY id`,
        params,
      );
      return rows;
    } finally {
      await client.end();
    }
  }

  /**
   * A team organization with an owner and a member. Nobody can invite anyone (a workspace
   * has one member), so the member is written straight to the database, as a workspace
   * made before that rule would have them.
   */
  async function team() {
    const owner = await signedInUser();
    const member = await signedInUser();
    const org = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await addMember(org.body.id, (await member.session.rpc.user.me()).id);
    await member.session.auth("/organization/set-active", { organizationId: org.body.id });
    await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
    const memberId = (await member.session.rpc.user.me()).id;
    return { owner, member, orgId: org.body.id, memberId };
  }

  it("records sign-up, the personal workspace and sessions as events", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const events = await outbox("actor_id = $1::uuid", [userId]);
    const names = events.map((event) => event.name);
    expect(names).toEqual(
      expect.arrayContaining(["auth.signed_up.v1", "org.created.v1", "auth.session_started.v1"]),
    );
    expect(events.find((e) => e.name === "auth.session_started.v1")?.payload).toMatchObject({
      userId,
      method: "email-code",
    });

    await session.auth("/sign-out");
    const after = await outbox("actor_id = $1::uuid AND name = 'auth.session_ended.v1'", [userId]);
    expect(after.at(-1)?.payload).toMatchObject({ reason: "sign-out" });
  });

  it("refuses an invitation: a workspace is its owner's alone", async () => {
    const { session } = await signedInUser();
    const { activeOrganizationId } = await session.rpc.user.me();
    const invite = await session.auth<{ code?: string }>("/organization/invite-member", {
      email: newEmail(),
      role: "member",
      organizationId: activeOrganizationId,
    });
    expect(invite.status).toBe(403);
    const anonymous = createSession(harness);
    expect(
      (await anonymous.auth("/organization/invite-member", { email: newEmail(), role: "member" }))
        .status,
    ).toBe(401);
  });

  it("records membership changes in the organization's own log, with who did them", async () => {
    const { owner, orgId, memberId } = await team();
    const { id: ownerId } = await owner.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      // A workspace is meant for one member, which is also better-auth's default page size.
      `/organization/list-members?organizationId=${orgId}&limit=100`,
    );
    const target = members.find((m) => m.userId === memberId)?.id;
    await owner.session.auth("/organization/update-member-role", {
      memberId: target,
      role: "admin",
      organizationId: orgId,
    });

    const events = await outbox("org_id = $1::uuid", [orgId]);
    // Creating an organization adds its creator as the first member.
    expect(events.map((e) => e.name)).toEqual([
      "org.member_added.v1",
      "org.created.v1",
      "org.member_role_changed.v1",
    ]);
    expect(events.at(-1)).toMatchObject({
      actor_id: ownerId,
      payload: { role: "admin", previousRole: "member" },
    });
  });

  it("won't let a client mark a workspace as someone's personal one", async () => {
    const { session } = await signedInUser();
    const slug = `team-${randomUUID().slice(0, 8)}`;
    for (const body of [
      { name: "Fake", slug, metadata: { personal: true } },
      { name: "Fake", slug: `personal-${randomUUID()}` },
    ]) {
      expect((await session.auth("/organization/create", body)).status).toBe(400);
    }
    const team = await session.auth<{ id: string }>("/organization/create", { name: "Team", slug });
    const update = await session.auth("/organization/update", {
      organizationId: team.body.id,
      data: { metadata: { personal: true } },
    });
    expect(update.status).toBe(400);
  });

  it(`caps the workspaces one account belongs to at ${ORGANIZATION_LIMIT}`, async () => {
    const { session } = await signedInUser();
    const create = () =>
      session.auth<{ code?: string }>("/organization/create", {
        name: "Many",
        slug: `many-${randomUUID().slice(0, 8)}`,
      });
    // The personal workspace is the first.
    for (let count = 1; count < ORGANIZATION_LIMIT; count++) {
      expect((await create()).status).toBe(200);
    }
    const over = await create();
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS");
  });

  it("a removed member loses access on their very next request", async () => {
    const { owner, member, orgId } = await team();
    await member.session.rpc.shorts.react({ videoId: "dQw4w9WgXcQ", kind: "like", on: true });

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    await expectError(
      member.session.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" }),
      "NO_ACTIVE_ORGANIZATION",
    );
    await expectError(
      member.session.rpc.shorts.react({ videoId: "dQw4w9WgXcQ", kind: "save", on: true }),
      "NO_ACTIVE_ORGANIZATION",
    );
  });

  it("a member who leaves loses access everywhere at once, and the leave is recorded", async () => {
    const { member, orgId, memberId } = await team();
    // A second session (another device), already holding the cached role.
    const elsewhere = createSession(harness);
    await elsewhere.auth("/sign-in/email", { email: member.email, password: member.password });
    await elsewhere.auth("/organization/set-active", { organizationId: orgId });
    await elsewhere.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" });

    expect(
      (await member.session.auth("/organization/leave", { organizationId: orgId })).status,
    ).toBe(200);
    await expectError(
      elsewhere.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" }),
      "NO_ACTIVE_ORGANIZATION",
    );
    const removed = await outbox("org_id = $1::uuid AND name = 'org.member_removed.v1'", [orgId]);
    expect(removed).toEqual([
      expect.objectContaining({
        actor_id: memberId,
        payload: expect.objectContaining({ userId: memberId }),
      }),
    ]);
  });

  it("records a member's departure when they delete their account", async () => {
    const { member, orgId, memberId } = await team();
    expect((await member.session.auth("/delete-user", { password: member.password })).status).toBe(
      200,
    );
    const removed = await outbox("org_id = $1::uuid AND name = 'org.member_removed.v1'", [orgId]);
    expect(removed).toEqual([
      expect.objectContaining({
        actor_id: memberId,
        payload: expect.objectContaining({ userId: memberId }),
      }),
    ]);
  });

  it("reads a stored role by an allow-list: an unknown one grants nothing, a compound one its strongest part", async () => {
    const { member, orgId, memberId } = await team();
    const setRole = async (role: string) => {
      const admin = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
      await admin.connect();
      await admin
        .query("UPDATE auth.member SET role = $1 WHERE organization_id = $2 AND user_id = $3", [
          role,
          orgId,
          memberId,
        ])
        .finally(() => admin.end());
      // As a membership change through better-auth would, forget the cached role.
      const cached = await harness.redis.keys(`cache:membership:*${orgId}:${memberId}`);
      if (cached.length) {
        await harness.redis.del(...cached);
      }
    };

    const reactions = () => member.session.rpc.shorts.reactions({ videoId: "dQw4w9WgXcQ" });
    // better-auth joins several roles with commas: the strongest one counts.
    await setRole("member,admin");
    expect(await reactions()).toEqual({ liked: false, saved: false });
    // A role the API doesn't know (a future "viewer", a typo, a hand edit) isn't a member:
    // it grants nothing at all.
    await setRole("viewer");
    await expectError(reactions(), "NO_ACTIVE_ORGANIZATION");
    await setRole("member,viewer");
    await expectError(reactions(), "NO_ACTIVE_ORGANIZATION");
    await setRole("member");
    expect(await reactions()).toEqual({ liked: false, saved: false });
  });
});

describe("realtime", () => {
  /** Reads a stream until `count` messages arrive. */
  async function read(stream: AsyncIterable<unknown>, count: number) {
    const received: unknown[] = [];
    for await (const message of stream) {
      received.push(message);
      if (received.length === count) {
        break;
      }
    }
    return received;
  }

  /** Waits until Redis has this process subscribed to each of the channels. */
  async function subscribed(...channels: string[]) {
    for (const channel of channels) {
      await eventually(
        async () => (await harness.redis.pubsub("NUMSUB", `realtime:${channel}`))[1],
        (subscribers) => Number(subscribers) > 0,
      );
    }
  }

  it("refuses an eleventh stream for one user with a typed error, and frees slots on close", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const { RealtimeService } = await import("../src/modules/realtime");
    const realtime = harness.app.get(RealtimeService);
    /** Whether the server would open another stream for this user now (opening none). */
    const full = () => {
      try {
        realtime.stream(
          me.id,
          required(me.activeOrganizationId, "the active workspace"),
          undefined,
        );
        return false;
      } catch {
        return true;
      }
    };
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const streams = await Promise.all(
      controllers.map((controller) =>
        session.rpc.realtime.subscribe(undefined, { signal: controller.signal }),
      ),
    );
    // Iterating is what opens each stream on the server.
    const readers = streams.map((stream) => read(stream, 1));
    await eventually(full, (isFull) => isFull);
    await expectError(
      (async () => {
        const extra = await session.rpc.realtime.subscribe();
        for await (const _ of extra) {
          break;
        }
      })(),
      "RATE_LIMITED",
    );
    for (const controller of controllers) {
      controller.abort();
    }
    // Aborting ends each reader with an AbortError: expected.
    await Promise.allSettled(readers);
    // Closed streams give their slots back: a new one opens and delivers.
    await eventually(full, (isFull) => !isFull);
    const again = await session.rpc.realtime.subscribe();
    const reading = read(again, 1);
    await subscribed(realtimeChannel.user(me.id));
    await publishRealtime(harness.redis, realtimeChannel.user(me.id), {
      type: "files.changed",
    });
    expect(await reading).toEqual([{ type: "files.changed" }]);
  });

  it("streams messages for the user and their active workspace only", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const orgId = required(me.activeOrganizationId, "the active workspace");
    const controller = new AbortController();
    const stream = await session.rpc.realtime.subscribe(undefined, { signal: controller.signal });
    const reading = read(stream, 2);
    await subscribed(realtimeChannel.user(me.id), realtimeChannel.org(orgId));
    await publishRealtime(harness.redis, realtimeChannel.org(orgIdSchema.parse(randomUUID())), {
      type: "director.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.org(orgId), {
      type: "director.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.user(me.id), {
      type: "files.changed",
    });
    const received = await reading;
    controller.abort();
    expect(received).toEqual([{ type: "director.changed" }, { type: "files.changed" }]);
  });

  it("drops a message outside the contract and keeps streaming", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const { RealtimeService } = await import("../src/modules/realtime");
    // In-process, without a signal: the stream ends when its reader stops.
    const stream = harness.app
      .get(RealtimeService)
      .stream(me.id, required(me.activeOrganizationId, "the active workspace"), undefined);
    const first = stream.next();
    await subscribed(realtimeChannel.user(me.id));
    await harness.redis.publish(
      `realtime:${realtimeChannel.user(me.id)}`,
      JSON.stringify({ type: "not.in.the.contract" }),
    );
    await publishRealtime(harness.redis, realtimeChannel.user(me.id), {
      type: "files.changed",
    });
    expect((await first).value).toEqual({ type: "files.changed" });
    await stream.return(undefined);
  });

  it("needs a session", async () => {
    const anonymous = createSession(harness);
    const stream = anonymous.rpc.realtime.subscribe(undefined);
    await expectError(
      stream.then((iterator) => iterator[Symbol.asyncIterator]().next()),
      "UNAUTHENTICATED",
    );
  });
});

describe("uploads and the profile picture", { tags: ["files"] }, () => {
  const storage = new S3Storage({
    bucket: LOCAL_STORAGE.S3_BUCKET,
    region: "us-east-1",
    endpoint: LOCAL_STORAGE.S3_ENDPOINT,
    accessKeyId: LOCAL_STORAGE.S3_ACCESS_KEY_ID,
    secretAccessKey: LOCAL_STORAGE.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005050201a5b2a1d20000000049454e44ae426082",
    "hex",
  );

  async function sql(query: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(query, params)).rows;
    } finally {
      await client.end();
    }
  }

  /** What apps/worker does once it has checked an upload. */
  async function markReady(fileId: string) {
    await storage.write(`files/${fileId}`, png, "image/webp");
    await sql(
      "UPDATE files.file SET status = 'ready', content_type = 'image/webp', size = $2, ready_at = now() WHERE id = $1",
      [fileId, png.length],
    );
  }

  async function uploaded(session: ReturnType<typeof createSession>) {
    const { file, upload } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: png });
    expect(put.status).toBe(200);
    return file;
  }

  it("signs an upload for exactly the file described, straight into quarantine", async () => {
    const { session } = await signedInUser();
    const { file, upload } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    expect(file).toMatchObject({ purpose: "avatar", status: "pending", filename: "me.png" });
    expect(new URL(upload.url).pathname).toContain(`/quarantine/${file.id}`);

    // A different type or size than was signed for is refused by storage itself.
    const swapped = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Type": "text/html" },
      body: png,
    });
    expect(swapped.status).toBe(403);
    const bigger = Buffer.concat([png, png]);
    const resized = await fetch(upload.url, {
      method: "PUT",
      headers: { ...upload.headers, "Content-Length": String(bigger.length) },
      body: bigger,
    });
    expect(resized.status).toBe(403);

    const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: png });
    expect(put.status).toBe(200);
    expect(await storage.head(`quarantine/${file.id}`)).toMatchObject({ size: png.length });
  });

  it("refuses types and sizes the purpose doesn't allow, before signing anything", async () => {
    const { session } = await signedInUser();
    const upload = (contentType: string, size: number) =>
      session.rpc.files.createUpload({ purpose: "avatar", filename: "x", contentType, size });
    const type = await expectError(upload("image/svg+xml", 100), "FILE_TYPE_NOT_ALLOWED");
    expect(type.data?.params).toMatchObject({ types: expect.stringContaining("image/png") });
    const size = await expectError(upload("image/png", 5_000_001), "FILE_TOO_LARGE");
    expect(size.data?.params).toMatchObject({ maxBytes: 5_000_000 });
    await expectError(upload("image/png", 0), "VALIDATION_FAILED");
  });

  it("completing queues one check, and only after the bytes are there", async () => {
    const { session } = await signedInUser();
    const { file } = await session.rpc.files.createUpload({
      purpose: "avatar",
      filename: "me.png",
      contentType: "image/png",
      size: png.length,
    });
    await expectError(session.rpc.files.completeUpload({ fileId: file.id }), "FILE_NOT_UPLOADED");

    const done = await uploaded(session);
    await session.rpc.files.completeUpload({ fileId: done.id });
    await session.rpc.files.completeUpload({ fileId: done.id });
    const queue = new Queue("files", { connection: harness.redis, prefix: queuePrefix("files") });
    const jobs = (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
      (job) => job.data.payload.fileId === done.id,
    );
    await queue.close();
    expect(jobs.map((job) => job.id)).toEqual([done.id]);
  });

  it("completing a file that's already been checked just returns it", async () => {
    const { session } = await signedInUser();
    const file = await uploaded(session);
    await markReady(file.id);
    expect(await session.rpc.files.completeUpload({ fileId: file.id })).toMatchObject({
      id: file.id,
      status: "ready",
    });
  });

  it("a file kept for another purpose can't be the picture, and downloads under its name", async () => {
    const { session } = await signedInUser();
    const file = await uploaded(session);
    await markReady(file.id);
    await sql("UPDATE files.file SET purpose = 'document', filename = 'notes.txt' WHERE id = $1", [
      file.id,
    ]);
    await expectError(session.rpc.user.setAvatar({ fileId: file.id }), "FILE_NOT_FOUND");
    const content = await fetch(`${harness.baseUrl}/api/v1/files/${file.id}/content`, {
      headers: { cookie: [...session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(content.status).toBe(302);
    const download = await fetch(content.headers.get("location") as string);
    expect(download.headers.get("content-disposition")).toContain("notes.txt");
  });

  it("answers an id that isn't a file id as not found", async () => {
    const { session } = await signedInUser();
    const response = await fetch(`${harness.baseUrl}/api/v1/files/not-an-id/content`, {
      headers: { cookie: [...session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("FILE_NOT_FOUND");
  });

  it("keeps each user's uploads private", async () => {
    const owner = await signedInUser();
    const file = await uploaded(owner.session);
    const other = await signedInUser();
    await expectError(other.session.rpc.files.get({ fileId: file.id }), "FILE_NOT_FOUND");
    await expectError(
      other.session.rpc.files.completeUpload({ fileId: file.id }),
      "FILE_NOT_FOUND",
    );
    await expect(owner.session.rpc.files.get({ fileId: file.id })).resolves.toMatchObject({
      id: file.id,
    });
  });

  it("sets a checked upload as the picture, served to anyone signed in", async () => {
    const { session } = await signedInUser();
    const file = await uploaded(session);
    await expectError(session.rpc.user.setAvatar({ fileId: file.id }), "FILE_NOT_READY");
    await markReady(file.id);

    const me = await session.rpc.user.setAvatar({ fileId: file.id });
    expect(me.image).toBe(`/api/v1/files/${file.id}/content`);
    expect((await session.rpc.user.me()).image).toBe(me.image);

    // Anyone signed in gets a short-lived storage URL; nobody signed out does.
    const viewer = await signedInUser();
    const content = await fetch(`${harness.baseUrl}${me.image}`, {
      headers: { cookie: [...viewer.session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(content.status).toBe(302);
    expect(content.headers.get("cache-control")).toBe("private, max-age=240");
    const image = await fetch(content.headers.get("location") as string);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect((await fetch(`${harness.baseUrl}${me.image}`, { redirect: "manual" })).status).toBe(401);
  });

  it("a picture must be the user's own, ready avatar", async () => {
    const owner = await signedInUser();
    const theirs = await uploaded(owner.session);
    await markReady(theirs.id);
    const other = await signedInUser();
    await expectError(other.session.rpc.user.setAvatar({ fileId: theirs.id }), "FILE_NOT_FOUND");
    await expectError(other.session.rpc.user.setAvatar({ fileId: randomUUID() }), "FILE_NOT_FOUND");
    // Pending files aren't served to anyone else, even by id.
    const pending = await uploaded(owner.session);
    const response = await fetch(`${harness.baseUrl}/api/v1/files/${pending.id}/content`, {
      headers: { cookie: [...other.session.cookies()].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });

  it("replacing or removing the picture deletes the old file and queues its objects", async () => {
    const { session } = await signedInUser();
    const first = await uploaded(session);
    await markReady(first.id);
    await session.rpc.user.setAvatar({ fileId: first.id });
    const second = await uploaded(session);
    await markReady(second.id);
    await session.rpc.user.setAvatar({ fileId: second.id });

    expect(await sql("SELECT id FROM files.file WHERE id = $1", [first.id])).toEqual([]);
    expect(
      (await sql("SELECT key FROM files.object_deletion WHERE key LIKE $1", [`%${first.id}`]))
        .map((row) => row.key)
        .sort(),
    ).toEqual([`files/${first.id}`, `quarantine/${first.id}`]);

    expect((await session.rpc.user.setAvatar({ fileId: null })).image).toBeNull();
    expect(await sql("SELECT id FROM files.file WHERE id = $1", [second.id])).toEqual([]);
  });

  it("the picture can't be set to an arbitrary URL through the auth API", async () => {
    const { session } = await signedInUser();
    const response = await session.auth("/update-user", {
      image: "https://tracker.example/pixel.gif",
    });
    expect(response.status).toBe(400);
    expect((await session.rpc.user.me()).image).toBeNull();
    // Other profile changes still work.
    expect((await session.auth("/update-user", { name: "Renamed" })).status).toBe(200);
  });

  it("limits how many uploads a user can start", async () => {
    const { session } = await signedInUser();
    const start = () =>
      session.rpc.files.createUpload({
        purpose: "avatar",
        filename: "x.png",
        contentType: "image/png",
        size: 10,
      });
    for (let i = 0; i < 30; i++) {
      await start();
    }
    await expectError(start(), "RATE_LIMITED");
  });

  it("reports files as on", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.features.files).toBe(true);
  });
});

describe("account deletion", () => {
  /** Counts an organization's reactions and says whether the org still exists (as the migrator). */
  async function orgState(orgId: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("migrator") });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const reactions = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM app.short_reaction",
      );
      const org = await client.query("SELECT 1 FROM auth.organization WHERE id = $1", [orgId]);
      await client.query("COMMIT");
      return { exists: org.rowCount === 1, reactions: Number(reactions.rows[0]?.count) };
    } finally {
      await client.end();
    }
  }

  it("removes the personal workspace and its data", async () => {
    const { session, password } = await signedInUser();
    await session.rpc.shorts.react({ videoId: "dQw4w9WgXcQ", kind: "like", on: true });
    const orgId = required(
      (await session.rpc.user.me()).activeOrganizationId,
      "the active workspace",
    );
    expect(await orgState(orgId)).toEqual({ exists: true, reactions: 1 });

    expect((await session.auth("/delete-user", { password })).status).toBe(200);
    expect(await orgState(orgId)).toEqual({ exists: false, reactions: 0 });
  });

  it("won't leave a shared workspace without an owner, and keeps its data", async () => {
    const owner = await signedInUser();
    const member = await signedInUser();
    const team = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await addMember(team.body.id, (await member.session.rpc.user.me()).id);
    await member.session.auth("/organization/set-active", { organizationId: team.body.id });
    await member.session.rpc.shorts.react({ videoId: "dQw4w9WgXcQ", kind: "like", on: true });

    const blocked = await owner.session.auth<{ code: string }>("/delete-user", {
      password: owner.password,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("ORGANIZATION_NEEDS_OWNER");

    const { id: memberUserId } = await member.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      // A workspace is meant for one member, which is also better-auth's default page size.
      `/organization/list-members?organizationId=${team.body.id}&limit=100`,
    );
    const target = members.find((m) => m.userId === memberUserId)?.id;
    expect(
      (
        await owner.session.auth("/organization/update-member-role", {
          memberId: target,
          role: "owner",
          organizationId: team.body.id,
        })
      ).status,
    ).toBe(200);

    expect((await owner.session.auth("/delete-user", { password: owner.password })).status).toBe(
      200,
    );
    // The team and the member's data survive.
    expect(await orgState(team.body.id)).toEqual({ exists: true, reactions: 1 });
  });
});

describe("the REST API's reference", () => {
  it("serves the OpenAPI document, and a page to read it outside production", async () => {
    const spec = await fetch(`${harness.baseUrl}/api/v1/openapi.json`);
    expect(spec.status).toBe(200);
    expect(((await spec.json()) as { info: object }).info).toMatchObject({
      title: "Director API",
    });
    const docs = await fetch(`${harness.baseUrl}/docs`);
    expect(docs.headers.get("content-type")).toContain("text/html");
    expect(await docs.text()).toContain('data-url="/api/v1/openapi.json"');
  });
});

describe("clients", () => {
  it("tells outdated apps to update", async () => {
    const outdated = createSession(harness, { appVersion: "1.9.0" });
    await expectError(outdated.rpc.system.info(), "CLIENT_OUTDATED");
    const current = createSession(harness, { appVersion: "2.0.0" });
    await expect(current.rpc.system.info()).resolves.toMatchObject({
      minimumClientVersion: "2.0.0",
    });
  });

  it("counts a version it can't read as outdated, so the gate can't be skipped", async () => {
    for (const appVersion of ["2.0.0-rc.1", "garbage", "3", "2.0", "v2.1.0", "NaN.NaN.NaN"]) {
      const session = createSession(harness, { appVersion });
      await expectError(session.rpc.system.info(), "CLIENT_OUTDATED");
    }
    for (const appVersion of ["2.0.1", "2.1.0-beta", "10.0.0"]) {
      await expect(createSession(harness, { appVersion }).rpc.system.info()).resolves.toMatchObject(
        { minimumClientVersion: "2.0.0" },
      );
    }
  });
});
