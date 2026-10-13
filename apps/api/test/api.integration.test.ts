/**
 * The API's security and behaviour guarantees, against the real app, database and Redis.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { ORPCError } from "@orpc/client";
import { WEBHOOK_SECRET_OVERLAP_HOURS } from "@repo/contracts/api";
import { ORGANIZATION_LIMIT, PENDING_INVITATION_LIMIT } from "@repo/contracts/auth";
import { orgIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { realtimeChannel } from "@repo/contracts/realtime";
import { queuePrefix } from "@repo/jobs";
import { AppError, createSignedTokens, S3Storage } from "@repo/nest-common";
import { eventually } from "@repo/testing/eventually";
import { totp } from "@repo/testing/totp";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhoneService } from "../src/modules/user/phone.service";
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
    // The test receiver below runs on loopback.
    WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1",
    VAPID_PUBLIC_KEY: "BPublicVapidKeyForTests",
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
    ["a malformed JSON body", "/api/v1/todos", json("{bad"), 400, "BAD_REQUEST"],
    ["an unknown route under /api/v1", "/api/v1/nope", {}, 404, "NOT_FOUND"],
    ["an unknown route anywhere else", "/v1/todos", {}, 404, "NOT_FOUND"],
    [
      "the wrong media type",
      "/api/v1/todos",
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
    ["no session on a procedure", "/api/v1/todos", {}, 401, "UNAUTHENTICATED"],
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

  it("tells a REST caller how to authenticate, and an outdated app to update, with fitting statuses", async () => {
    const unauthenticated = await send("/api/v1/todos");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe('ApiKey header="x-api-key"');
    const outdated = await send("/api/v1/todos", { headers: { "x-app-version": "1.0.0" } });
    expect(outdated.status).toBe(400);
    expect(((await outdated.json()) as { code: string }).code).toBe("CLIENT_OUTDATED");
  });

  it("refuses, outside production, to answer a code the procedure's contract doesn't declare", async () => {
    const { session } = await signedInUser();
    const { TodoService } = await import("../src/modules/todo");
    const todos = harness.app.get(TodoService);
    // A code the todo contract has no business returning.
    const list = vi.spyOn(todos, "list").mockRejectedValueOnce(new AppError("PHONE_CODE_INVALID"));
    await expectError(session.rpc.todo.list({ limit: 1 }), "INTERNAL");
    list.mockRestore();
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
    expect(await statusFor("/rpc/todo/create", big)).toBe(413);
    expect(await statusFor("/api/v1/todos", big)).toBe(413);
    // 100 MB of text, unauthenticated: refused from the headers, never read.
    expect(await statusFor("/rpc/todo/create", 100 * 1024 * 1024, "text/plain")).toBe(415);
  });

  it("accepts only JSON on the API routes", async () => {
    for (const type of [
      "text/plain",
      "application/octet-stream",
      "multipart/form-data; boundary=x",
    ]) {
      expect((await post("/rpc/todo/create", type, "x".repeat(1024))).status, type).toBe(415);
      expect((await post("/api/v1/todos", type, "x".repeat(1024))).status, type).toBe(415);
    }
  });

  it("still serves JSON calls", async () => {
    const response = await post(
      "/rpc/todo/list",
      "application/json",
      JSON.stringify({ json: { limit: 1 } }),
    );
    // Unauthenticated, but parsed and routed: the procedure answered.
    expect(response.status).toBe(401);
  });
});

describe("the mobile sign-in redirect", () => {
  const proxy = (target: string) =>
    fetch(
      `${harness.baseUrl}/api/auth/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: target })}`,
      { redirect: "manual" },
    );

  it("sends people only to a sign-in provider", async () => {
    const google = await proxy("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(google.status).toBe(302);
    expect(google.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it("refuses a request without an address", async () => {
    const response = await fetch(`${harness.baseUrl}/api/auth/expo-authorization-proxy`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
  });

  it("refuses any other address", async () => {
    for (const target of [
      "https://evil.example/login?state=abc",
      "https://accounts.google.com.evil.example/?state=abc",
      "not a url",
    ]) {
      const response = await proxy(target);
      expect(response.status, target).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
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

describe("Google sign-in on the mobile app", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Google's token endpoint, answering any code with an id token for `email`. */
  function google(email: string) {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://oauth2.googleapis.com/token")) {
        return real(input, init);
      }
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const claims = {
        iss: "https://accounts.google.com",
        aud: GOOGLE_CLIENT_ID,
        sub: randomUUID(),
        email,
        email_verified: true,
        name: "Ada",
      };
      return Promise.resolve(
        Response.json({
          access_token: "google-access-token",
          id_token: `${part({ alg: "RS256" })}.${part(claims)}.signature`,
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    });
  }

  /**
   * The app starts a sign-in with `callbackURL`; the browser goes through the proxy to
   * Google, which sends it back with a code (or `error`). Where the callback sends it.
   */
  async function signIn(callbackURL: string, back: Record<string, string> = { code: "a" }) {
    const app = createSession(harness);
    const started = await app.auth<{ url: string }>("/sign-in/social", {
      provider: "google",
      callbackURL,
      disableRedirect: true,
    });
    const authorizationURL = started.body.url;
    const proxied = await fetch(
      `${harness.baseUrl}/api/auth/expo-authorization-proxy?${new URLSearchParams({ authorizationURL })}`,
      { redirect: "manual" },
    );
    const state = new URL(authorizationURL).searchParams.get("state") as string;
    const callback = await fetch(
      `${harness.baseUrl}/api/auth/callback/google?${new URLSearchParams({ ...back, state })}`,
      {
        headers: {
          cookie: proxied.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; "),
        },
        redirect: "manual",
      },
    );
    return new URL(callback.headers.get("location") as string);
  }

  const start = () =>
    createSession(harness).auth<{ id: string; secret: string }>("/mobile/sign-in/start");
  const finish = (body: { id: string; secret: string }) =>
    fetch(`${harness.baseUrl}/api/auth/mobile/sign-in/finish`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: String(process.env.WEB_URL) },
      body: JSON.stringify(body),
    });

  it("hands the session only to the app that started the sign-in, once", async () => {
    const email = newEmail();
    google(email);
    const { body: handoff } = await start();
    const back = await signIn(`boilerplate:///?handoff=${handoff.id}`);
    // The link names the hand-off and carries no session: catching it gets nothing.
    expect(back.protocol).toBe("boilerplate:");
    expect(back.searchParams.get("handoff")).toBe(handoff.id);
    expect(back.searchParams.get("cookie")).toBeNull();

    const finished = await finish(handoff);
    expect(finished.status).toBe(200);
    const token = /(?:__Secure-)?[\w.-]*session_token=[^;]+/.exec(
      String(finished.headers.get("set-cookie")),
    )?.[0];
    const session = await fetch(`${harness.baseUrl}/api/auth/get-session`, {
      headers: { cookie: String(token) },
    }).then((response) => response.json() as Promise<{ user: { email: string } }>);
    expect(session.user.email).toBe(email);
    // Once only.
    expect((await finish(handoff)).status).toBe(401);
  });

  it("burns the hand-off on a wrong secret, so a caught link can't be tried twice", async () => {
    google(newEmail());
    const { body: handoff } = await start();
    await signIn(`boilerplate:///?handoff=${handoff.id}`);
    const wrong = await finish({ id: handoff.id, secret: "guess" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: "SIGN_IN_INCOMPLETE" });
    expect((await finish(handoff)).status).toBe(401);
  });

  it("puts no session in a link to the app without a hand-off it started", async () => {
    google(newEmail());
    for (const callbackURL of ["boilerplate:///", `boilerplate:///?handoff=${"x".repeat(43)}`]) {
      const back = await signIn(callbackURL);
      expect(back.protocol).toBe("boilerplate:");
      expect(back.searchParams.get("cookie"), callbackURL).toBeNull();
    }
    // Nor to the web app, which gets its cookie from the redirect itself.
    expect((await signIn(String(process.env.WEB_URL))).origin).toBe(
      new URL(String(process.env.WEB_URL)).origin,
    );
  });

  it("has nothing to hand over before the sign-in, or after it failed", async () => {
    const early = await start();
    expect((await finish(early.body)).status).toBe(401);
    const { body: handoff } = await start();
    const back = await signIn(`boilerplate:///?handoff=${handoff.id}`, { error: "access_denied" });
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect((await finish(handoff)).status).toBe(401);
  });
});

describe("profile settings", () => {
  it("saves a known language and time zone, and refuses anything else", async () => {
    const { session } = await signedInUser();
    expect(
      (await session.auth("/update-user", { locale: "es", timezone: "Asia/Tokyo" })).status,
    ).toBe(200);
    expect(await session.rpc.user.me()).toMatchObject({ locale: "es", timezone: "Asia/Tokyo" });
    for (const change of [{ locale: "xx" }, { timezone: "Mars/Olympus" }]) {
      const refused = await session.auth<{ code?: string }>("/update-user", change);
      expect(refused.status, JSON.stringify(change)).toBe(400);
      expect(refused.body.code).toBe("VALIDATION_FAILED");
    }
    expect(await session.rpc.user.me()).toMatchObject({ locale: "es", timezone: "Asia/Tokyo" });
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
    await expectError(session.rpc.todo.list({}), "NO_ACTIVE_ORGANIZATION");
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
    const session = createSession(harness, { locale: "es-ES,es;q=0.9" });
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
    expect(code).toMatchObject({ locale: "es", purpose: "email-verification" });
    expect(code.otp).toMatch(/^\d{6}$/);

    await session.auth("/email-otp/verify-email", { email, otp: code.otp });
    const me = await session.rpc.user.me();
    expect(me).toMatchObject({ email, locale: "es" });
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

  /** A team organization with an owner and a member (who joined by invitation). */
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
    const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
    await member.session.auth("/organization/accept-invitation", { invitationId });
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

  it("records membership changes in the organization's own log, with who did them", async () => {
    const { owner, orgId, memberId } = await team();
    const { id: ownerId } = await owner.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      `/organization/list-members?organizationId=${orgId}`,
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
      "org.invitation_sent.v1",
      "org.member_added.v1",
      "org.member_role_changed.v1",
    ]);
    expect(events.at(-1)).toMatchObject({
      actor_id: ownerId,
      payload: { role: "admin", previousRole: "member" },
    });
  });

  it("limits invitations, per address and per workspace, so our domain can't be used to spam", async () => {
    const { owner, orgId } = await team();
    const invite = (email: string, resend = false) =>
      owner.session.auth<{ code?: string }>("/organization/invite-member", {
        email,
        role: "member",
        organizationId: orgId,
        resend,
      });
    // One address: three emails a day, however they're asked for.
    const target = newEmail();
    expect((await invite(target)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(200);
    expect((await invite(target, true)).status).toBe(429);
    // One workspace: PENDING_INVITATION_LIMIT waiting at once (the team already has one,
    // its member's accepted one doesn't count, and the one above does).
    let sent = 1;
    while (sent < PENDING_INVITATION_LIMIT) {
      expect((await invite(newEmail())).status).toBe(200);
      sent++;
    }
    const over = await invite(newEmail());
    expect(over.status).toBe(403);
    expect(over.body.code).toBe("INVITATION_LIMIT_REACHED");
  });

  it("limits the invitations one person sends in an hour, across workspaces", async () => {
    const { session } = await signedInUser();
    const workspace = async () => {
      const org = await session.auth<{ id: string }>("/organization/create", {
        name: "Team",
        slug: `team-${randomUUID().slice(0, 8)}`,
      });
      return org.body.id;
    };
    const invite = (organizationId: string) =>
      session.auth<{ code?: string }>("/organization/invite-member", {
        email: newEmail(),
        role: "member",
        organizationId,
      });
    // Two workspaces, so the per-workspace limit on waiting invitations isn't what stops it.
    const [first, second] = [await workspace(), await workspace()];
    for (let i = 0; i < PENDING_INVITATION_LIMIT; i++) {
      expect((await invite(first)).status).toBe(200);
    }
    for (let i = PENDING_INVITATION_LIMIT; i < 30; i++) {
      expect((await invite(second)).status).toBe(200);
    }
    const over = await invite(second);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("RATE_LIMITED");
  });

  it("refuses an invitation without a session, or without an address", async () => {
    const { session } = await signedInUser();
    const anonymous = createSession(harness);
    expect(
      (await anonymous.auth("/organization/invite-member", { email: newEmail(), role: "member" }))
        .status,
    ).toBe(401);
    const noAddress = await session.auth("/organization/invite-member", {
      email: 42,
      role: "member",
    });
    expect(noAddress.status).toBe(400);
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
    await member.session.rpc.todo.create({ title: "Mine for now" });

    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    await expectError(member.session.rpc.todo.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
    await expectError(
      member.session.rpc.todo.create({ title: "Sneaky" }),
      "NO_ACTIVE_ORGANIZATION",
    );
  });

  it("a member who leaves loses access everywhere at once, and the leave is recorded", async () => {
    const { member, orgId, memberId } = await team();
    // A second session (another device), already holding the cached role.
    const elsewhere = createSession(harness);
    await elsewhere.auth("/sign-in/email", { email: member.email, password: member.password });
    await elsewhere.auth("/organization/set-active", { organizationId: orgId });
    await elsewhere.rpc.todo.list({ limit: 20 });

    expect(
      (await member.session.auth("/organization/leave", { organizationId: orgId })).status,
    ).toBe(200);
    await expectError(elsewhere.rpc.todo.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
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

  it("only owners and admins read the audit log, and only their organization's", async () => {
    const { owner, member, orgId } = await team();
    // The worker writes the audit log; here, rows are written directly as it would.
    const admin = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await admin.connect();
    await admin.query("SELECT audit.ensure_partitions(1, 1)");
    await admin.query(
      `INSERT INTO audit.audit_log (id, occurred_at, name, key, payload, org_id, source)
       VALUES (uuidv7(), now(), 'todo.created.v1', 'k', '{"title":"Audited"}', $1, 'app'),
              (uuidv7(), now(), 'todo.created.v1', 'k', '{"title":"Other org"}', $2, 'app')`,
      [orgId, randomUUID()],
    );
    await admin.end();

    const log = await owner.session.rpc.audit.list({ limit: 20 });
    expect(log.items.map((entry) => entry.payload.title)).toEqual(["Audited"]);
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "FORBIDDEN");
  });

  it("names who did each thing in the audit log, newest first, a page at a time", async () => {
    const { owner, orgId } = await team();
    const { id: ownerId } = await owner.session.rpc.user.me();
    const admin = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await admin.connect();
    await admin.query("SELECT audit.ensure_partitions(1, 1)");
    // Oldest first: by the owner, by an account deleted since, and by the system (a job).
    for (const [actor, payload] of [
      [ownerId, '{"title":"By the owner"}'],
      [randomUUID(), "null"],
      [null, '{"title":"By a job"}'],
    ]) {
      await admin.query(
        `INSERT INTO audit.audit_log (id, occurred_at, name, key, payload, org_id, actor_id, source)
         VALUES (uuidv7(), now(), 'todo.created.v1', 'k', $1::jsonb, $2, $3, 'app')`,
        [payload, orgId, actor],
      );
    }
    await admin.end();

    const first = await owner.session.rpc.audit.list({ limit: 2 });
    expect(first.items.map((entry) => [entry.actor, entry.payload])).toEqual([
      [null, { title: "By a job" }],
      [null, {}],
    ]);
    const rest = await owner.session.rpc.audit.list({
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(rest.items.find((entry) => entry.payload.title === "By the owner")?.actor).toMatchObject(
      { id: ownerId },
    );
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

    // better-auth joins several roles with commas: the strongest one counts.
    await setRole("member,admin");
    expect((await member.session.rpc.audit.list({ limit: 20 })).items).toEqual([]);
    // A role the API doesn't know (a future "viewer", a typo, a hand edit) isn't an admin,
    // nor a member: it grants nothing at all.
    await setRole("viewer");
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "NO_ACTIVE_ORGANIZATION");
    await expectError(member.session.rpc.todo.list({}), "NO_ACTIVE_ORGANIZATION");
    await setRole("member,viewer");
    await expectError(member.session.rpc.todo.list({}), "NO_ACTIVE_ORGANIZATION");
    await setRole("member");
    await expectError(member.session.rpc.audit.list({ limit: 20 }), "FORBIDDEN");
    expect((await member.session.rpc.todo.list({})).items).toEqual([]);
  });
});

describe("webhook endpoints", () => {
  const url = "http://127.0.0.1:9/hook";

  it("limits test sends per workspace, so our servers can't flood an endpoint", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({
      url,
      events: ["todo.created.v1"],
    });
    for (let i = 0; i < 10; i++) {
      await session.rpc.webhooks.sendTest({ id: endpoint.id });
    }
    const limited = await expectError(
      session.rpc.webhooks.sendTest({ id: endpoint.id }),
      "RATE_LIMITED",
    );
    expect(limited.data.params).toMatchObject({ retryAfterSeconds: expect.any(Number) });
  });

  it("needs a recent sign-in to add one or point it elsewhere", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({
      url,
      events: ["todo.created.v1"],
    });
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });
    await expectError(
      session.rpc.webhooks.createEndpoint({ url, events: ["todo.created.v1"] }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(
      session.rpc.webhooks.updateEndpoint({ id: endpoint.id, url: "http://127.0.0.1:9/other" }),
      "FRESH_SESSION_REQUIRED",
    );
    // Anything else about it doesn't.
    await expect(
      session.rpc.webhooks.updateEndpoint({ id: endpoint.id, enabled: false }),
    ).resolves.toMatchObject({ url });
  });

  it("returns the signing secret once and keeps it encrypted at rest", async () => {
    const { session } = await signedInUser();
    const created = await session.rpc.webhooks.createEndpoint({ url, events: ["todo.created.v1"] });
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.endpoint).toMatchObject({ url, events: ["todo.created.v1"], disabledAt: null });
    expect(JSON.stringify(await session.rpc.webhooks.listEndpoints())).not.toContain(
      created.secret,
    );

    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query("SELECT secret FROM webhooks.endpoint WHERE id = $1", [
      created.endpoint.id,
    ]);
    const events = await client.query("SELECT name FROM app.outbox_event WHERE key = $1", [
      created.endpoint.id,
    ]);
    await client.end();
    expect(rows[0].secret).not.toContain(created.secret.slice(6));
    expect(rows[0].secret).toMatch(/^v2\./);
    expect(events.rows.map((row) => row.name)).toEqual(["webhook.endpoint_created.v1"]);

    const rotated = await session.rpc.webhooks.rotateSecret({ id: created.endpoint.id });
    expect(rotated.secret).not.toBe(created.secret);
    // The replaced secret keeps signing for the overlap (apps/webhooks signs with both).
    const after = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await after.connect();
    const { rows: stored } = await after
      .query<{ secret: string; previous_secret: string; previous_secret_expires_at: Date }>(
        "SELECT secret, previous_secret, previous_secret_expires_at FROM webhooks.endpoint WHERE id = $1",
        [created.endpoint.id],
      )
      .finally(() => after.end());
    expect(stored[0]?.previous_secret).toBe(rows[0].secret);
    expect(stored[0]?.secret).not.toBe(rows[0].secret);
    const overlap = (stored[0]?.previous_secret_expires_at.getTime() ?? 0) - Date.now();
    expect(overlap).toBeGreaterThan((WEBHOOK_SECRET_OVERLAP_HOURS - 1) * 3_600_000);
    expect(overlap).toBeLessThanOrEqual(WEBHOOK_SECRET_OVERLAP_HOURS * 3_600_000);
  });

  it("refuses URLs that point at private or unresolvable hosts", async () => {
    const { session } = await signedInUser();
    for (const bad of [
      "http://10.0.0.1/hook",
      "http://169.254.169.254/latest",
      "https://does-not-exist.invalid/",
    ]) {
      await expectError(
        session.rpc.webhooks.createEndpoint({ url: bad }),
        "WEBHOOK_URL_NOT_ALLOWED",
      );
    }
  });

  it("refuses a host name longer than DNS allows, as invalid rather than a DNS outage", async () => {
    const { session } = await signedInUser();
    const tooLong = `https://${`${"a".repeat(63)}.`.repeat(4)}example/hook`;
    const created = await expectError(
      session.rpc.webhooks.createEndpoint({ url: tooLong }),
      "VALIDATION_FAILED",
    );
    expect(created.data.issues).toEqual([{ path: ["url"], code: "invalid_format" }]);
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    await expectError(
      session.rpc.webhooks.updateEndpoint({ id: endpoint.id, url: tooLong }),
      "VALIDATION_FAILED",
    );
  });

  it("turns an endpoint off and on, and records who changed what", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    const off = await session.rpc.webhooks.updateEndpoint({ id: endpoint.id, enabled: false });
    expect(off).toMatchObject({ disabledReason: "manual" });
    expect(off.disabledAt).toBeInstanceOf(Date);
    const on = await session.rpc.webhooks.updateEndpoint({
      id: endpoint.id,
      enabled: true,
      description: "Prod",
    });
    expect(on).toMatchObject({ disabledAt: null, disabledReason: null, description: "Prod" });
  });

  it("queues a test event for the delivery service", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    await session.rpc.webhooks.sendTest({ id: endpoint.id });
    const queue = new Queue("webhook-deliveries", {
      connection: harness.redis,
      prefix: queuePrefix("webhook-deliveries"),
    });
    const jobs = await queue.getJobs(["waiting"]);
    await queue.close();
    expect(
      jobs.some((job) => job.name === "send-test" && job.data.payload.endpointId === endpoint.id),
    ).toBe(true);
  });

  it("is for owners and admins of the organization only", async () => {
    const owner = await signedInUser();
    const { endpoint } = await owner.session.rpc.webhooks.createEndpoint({ url });
    const stranger = await signedInUser();
    expect(await stranger.session.rpc.webhooks.listEndpoints()).toEqual([]);
    await expectError(
      stranger.session.rpc.webhooks.deleteEndpoint({ id: endpoint.id }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
    await expectError(
      stranger.session.rpc.webhooks.listDeliveries({ id: endpoint.id, limit: 20 }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
  });

  it("records only what an update really changed", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    const changes = async () => {
      const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
      await client.connect();
      const { rows } = await client
        .query<{ payload: { changed: string[] } }>(
          "SELECT payload FROM app.outbox_event WHERE key = $1 AND name = 'webhook.endpoint_updated.v1' ORDER BY id",
          [endpoint.id],
        )
        .finally(() => client.end());
      return rows.map((row) => row.payload.changed);
    };
    // The same URL, description and state again: nothing to record.
    await session.rpc.webhooks.updateEndpoint({ id: endpoint.id, url, enabled: true });
    expect(await changes()).toEqual([]);
    const updated = await session.rpc.webhooks.updateEndpoint({
      id: endpoint.id,
      url: "http://127.0.0.1:9/moved",
      events: ["todo.completed.v1"],
    });
    expect(updated).toMatchObject({
      url: "http://127.0.0.1:9/moved",
      events: ["todo.completed.v1"],
    });
    expect(await changes()).toEqual([["url", "events"]]);
    await expectError(
      session.rpc.webhooks.updateEndpoint({ id: randomUUID(), enabled: false }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
  });

  it("deletes an endpoint, once", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    await session.rpc.webhooks.deleteEndpoint({ id: endpoint.id });
    expect(await session.rpc.webhooks.listEndpoints()).toEqual([]);
    await expectError(
      session.rpc.webhooks.deleteEndpoint({ id: endpoint.id }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
  });

  it("can't rotate the secret of, or test, an endpoint that isn't there", async () => {
    const { session } = await signedInUser();
    await expectError(
      session.rpc.webhooks.rotateSecret({ id: randomUUID() }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
    await expectError(
      session.rpc.webhooks.sendTest({ id: randomUUID() }),
      "WEBHOOK_ENDPOINT_NOT_FOUND",
    );
  });

  it("lists an endpoint's deliveries newest first, and sends one again", async () => {
    const { session } = await signedInUser();
    const { endpoint } = await session.rpc.webhooks.createEndpoint({ url });
    const { activeOrganizationId: orgId } = await session.rpc.user.me();
    // apps/webhooks records deliveries; here they're written as it would, oldest first.
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const ids: string[] = [];
    for (const [status, lastError] of [
      ["succeeded", null],
      ["failed", "timeout"],
      // A code from before the current list reads as a failed connection.
      ["failed", "socket hang up"],
    ]) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO webhooks.delivery (endpoint_id, org_id, event_id, event_name, body, status, attempts, last_error)
         VALUES ($1, $2, $3, 'todo.created.v1', '{}', $4, 1, $5) RETURNING id`,
        [endpoint.id, orgId, randomUUID(), status, lastError],
      );
      ids.push((rows[0] as { id: string }).id);
    }
    await client.end();

    const first = await session.rpc.webhooks.listDeliveries({ id: endpoint.id, limit: 2 });
    expect(first.items.map((delivery) => [delivery.status, delivery.lastError])).toEqual([
      ["failed", "connection_failed"],
      ["failed", "timeout"],
    ]);
    const rest = await session.rpc.webhooks.listDeliveries({
      id: endpoint.id,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(rest).toMatchObject({ items: [{ id: ids[0], status: "succeeded" }], nextCursor: null });

    await session.rpc.webhooks.redeliver({ id: ids[1] as string });
    const queue = new Queue("webhook-deliveries", {
      connection: harness.redis,
      prefix: queuePrefix("webhook-deliveries"),
    });
    const jobs = await queue.getJobs(["waiting"]);
    await queue.close();
    expect(
      jobs.some((job) => job.name === "redeliver" && job.data.payload.deliveryId === ids[1]),
    ).toBe(true);

    // Another workspace's delivery, or none at all, isn't found.
    const stranger = await signedInUser();
    await expectError(
      stranger.session.rpc.webhooks.redeliver({ id: ids[1] as string }),
      "WEBHOOK_DELIVERY_NOT_FOUND",
    );
  });

  it("limits endpoints per organization", async () => {
    const { session } = await signedInUser();
    for (let i = 0; i < 20; i++) {
      await session.rpc.webhooks.createEndpoint({ url });
    }
    const error = await expectError(
      session.rpc.webhooks.createEndpoint({ url }),
      "WEBHOOK_ENDPOINT_LIMIT",
    );
    expect(error.data.params).toEqual({ max: 20 });
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
      type: "notifications.changed",
    });
    expect(await reading).toEqual([{ type: "notifications.changed" }]);
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
      type: "todos.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.org(orgId), {
      type: "todos.changed",
    });
    await publishRealtime(harness.redis, realtimeChannel.user(me.id), {
      type: "notifications.changed",
    });
    const received = await reading;
    controller.abort();
    expect(received).toEqual([{ type: "todos.changed" }, { type: "notifications.changed" }]);
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
      type: "notifications.changed",
    });
    expect((await first).value).toEqual({ type: "notifications.changed" });
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

describe("notifications", () => {
  /** Puts in-app notifications in a user's inbox, as apps/notifications does. */
  async function deliver(userId: string, titles: string[]) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    for (const title of titles) {
      await client.query(
        `INSERT INTO notifications.notification (user_id, template, data, link) VALUES ($1, 'todo.reminder', $2, '/dashboard')`,
        [userId, JSON.stringify({ todoId: randomUUID(), title })],
      );
    }
    await client.end();
  }

  it("lists the inbox newest first, counts unread, marks read", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    await deliver(me.id, ["first", "second", "third"]);
    const page = await session.rpc.notifications.list({ limit: 2 });
    expect(page.items.map((item) => item.data.title)).toEqual(["third", "second"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 3 });

    const rest = await session.rpc.notifications.list({
      limit: 2,
      cursor: page.nextCursor as string,
    });
    expect(rest).toMatchObject({ items: [{ data: { title: "first" } }], nextCursor: null });

    await session.rpc.notifications.markRead({ ids: [page.items[0]?.id as string] });
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 2 });
    await session.rpc.notifications.markAllRead();
    expect(await session.rpc.notifications.unreadCount()).toEqual({ count: 0 });
  });

  it("lists a notification that carries no data", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    await client
      .query(
        `INSERT INTO notifications.notification (user_id, template, data, link) VALUES ($1, 'todo.reminder', 'null', '/dashboard')`,
        [me.id],
      )
      .finally(() => client.end());
    const { items } = await session.rpc.notifications.list({ limit: 20 });
    expect(items.map((item) => item.data)).toEqual([{}]);
  });

  it("keeps each inbox private", async () => {
    const owner = await signedInUser();
    await deliver((await owner.session.rpc.user.me()).id, ["private"]);
    const other = await signedInUser();
    expect((await other.session.rpc.notifications.list({ limit: 20 })).items).toEqual([]);
  });

  it("saves preferences, digest and quiet hours, but security email can't be turned off", async () => {
    const { session } = await signedInUser();
    const defaults = await session.rpc.notifications.preferences();
    expect(defaults.categories.map((c) => c.name)).toEqual(["workspace", "activity"]);
    expect(defaults.categories.every((c) => c.channels.every((ch) => ch.enabled))).toBe(true);

    const updated = await session.rpc.notifications.updatePreferences({
      channels: [{ category: "activity", channel: "email", enabled: false }],
      dailyDigest: true,
      quietHours: { start: 22 * 60, end: 7 * 60 },
    });
    expect(updated.categories.find((c) => c.name === "activity")?.channels).toContainEqual({
      channel: "email",
      enabled: false,
    });
    expect(updated).toMatchObject({ dailyDigest: true, quietHours: { start: 1320, end: 420 } });

    // Changing only the digest, then clearing quiet hours, keeps everything else.
    expect(await session.rpc.notifications.updatePreferences({ dailyDigest: false })).toMatchObject(
      { dailyDigest: false, quietHours: { start: 1320, end: 420 } },
    );
    const cleared = await session.rpc.notifications.updatePreferences({ quietHours: null });
    expect(cleared).toMatchObject({ dailyDigest: false, quietHours: null });
    expect(cleared.categories.find((c) => c.name === "activity")?.channels).toContainEqual({
      channel: "email",
      enabled: false,
    });

    await expectError(
      session.rpc.notifications.updatePreferences({
        channels: [{ category: "security", channel: "email", enabled: false }],
      }),
      "VALIDATION_FAILED",
    );
  });

  it("answers a one-click unsubscribe without a token as an invalid link", async () => {
    const response = await fetch(`${harness.baseUrl}/api/v1/notifications/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("UNSUBSCRIBE_LINK_INVALID");
  });

  it("unsubscribes from a signed link, one-click included, and rejects forgeries", async () => {
    const { session } = await signedInUser();
    const { id } = await session.rpc.user.me();
    const tokens = createSignedTokens(process.env.UNSUBSCRIBE_SECRET as string);

    const anonymous = createSession(harness);
    expect(
      await anonymous.rpc.notifications.unsubscribe({
        token: tokens.sign("unsubscribe", [id, "activity"]),
      }),
    ).toEqual({ category: "activity" });
    const oneClick = await fetch(
      `${harness.baseUrl}/api/v1/notifications/unsubscribe?token=${encodeURIComponent(tokens.sign("unsubscribe", [id, "workspace"]))}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    expect(oneClick.status).toBe(200);
    const preferences = await session.rpc.notifications.preferences();
    for (const category of preferences.categories) {
      expect(category.channels.find((ch) => ch.channel === "email")?.enabled).toBe(false);
    }

    await expectError(
      anonymous.rpc.notifications.unsubscribe({ token: "forged.token" }),
      "UNSUBSCRIBE_LINK_INVALID",
    );
    await expectError(
      anonymous.rpc.notifications.unsubscribe({
        token: tokens.sign("unsubscribe", [id, "security"]),
      }),
      "UNSUBSCRIBE_LINK_INVALID",
    );
  });
});

describe("phone number", () => {
  const newPhone = () => `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

  async function addPhone(session: ReturnType<typeof createSession>, phoneNumber = newPhone()) {
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    const me = await session.rpc.user.verifyPhone({ phoneNumber, code: data.code });
    return { phoneNumber, me, code: data.code };
  }

  async function outboxEvents(userId: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query<{ payload: { change: string } }>(
      "SELECT payload FROM app.outbox_event WHERE name = 'auth.phone_changed.v1' AND key = $1 ORDER BY occurred_at",
      [userId],
    );
    await client.end();
    return rows.map((row) => row.payload.change);
  }

  it("adds a number once the texted code matches, audits it and alerts the account", async () => {
    const { session, email } = await signedInUser("es");
    const me = await session.rpc.user.me();
    expect(me.phoneNumber).toBeNull();

    const phoneNumber = newPhone();
    // Spaces, dashes and brackets are fine; the number is stored as E.164.
    const formatted = `${phoneNumber.slice(0, 2)} (${phoneNumber.slice(2, 5)}) ${phoneNumber.slice(5, 8)}-${phoneNumber.slice(8)}`;
    expect(await session.rpc.user.sendPhoneCode({ phoneNumber: formatted })).toEqual({
      expiresInSeconds: 600,
    });
    const text = await takeNotification(harness, "auth.phone-code", phoneNumber);
    expect(text.to.locale).toBe("es");
    expect(text.data.code).toMatch(/^\d{6}$/);

    const updated = await session.rpc.user.verifyPhone({ phoneNumber, code: text.data.code });
    expect(updated.phoneNumber).toBe(phoneNumber);
    expect((await session.rpc.user.me()).phoneNumber).toBe(phoneNumber);
    expect(await outboxEvents(me.id)).toEqual(["added"]);

    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data.event).toBe("phone-added");
    expect(alert.to.phone).toBe(phoneNumber);
  });

  it("rejects wrong codes, and forgets the code after five wrong guesses", async () => {
    const { session } = await signedInUser();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    const wrong = data.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expectError(
        session.rpc.user.verifyPhone({ phoneNumber, code: wrong }),
        "PHONE_CODE_INVALID",
      );
    }
    // The right code no longer works: guessing can't continue past the limit.
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
    expect((await session.rpc.user.me()).phoneNumber).toBeNull();
  });

  it("counts parallel guesses too: no more than five are ever compared", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    const wrong = data.code === "000000" ? "111111" : "000000";
    // In-process, so the guesses really interleave at every Redis round trip. Imported
    // only now: it loads the API's configuration, which startApi sets up first.
    const phone = harness.app.get<PhoneService>(
      (await import("../src/modules/user/phone.service")).PhoneService,
    );
    const guesses = await Promise.allSettled(
      Array.from({ length: 15 }, () => phone.verify(userId, phoneNumber, wrong)),
    );
    expect(guesses.every((guess) => guess.status === "rejected")).toBe(true);
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
  });

  it("a code only verifies the number it was sent to, and only once", async () => {
    const { session } = await signedInUser();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: data.code }),
      "PHONE_CODE_INVALID",
    );
    await session.rpc.user.verifyPhone({ phoneNumber, code: data.code });
    await session.rpc.user.removePhone();
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
  });

  it("a code sent to one account can't verify another's", async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const phoneNumber = newPhone();
    await first.session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    await expectError(
      second.session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_CODE_INVALID",
    );
  });

  it("a number can be on one account only, which shows only when verifying it", async () => {
    const owner = await signedInUser();
    const { phoneNumber } = await addPhone(owner.session);
    const other = await signedInUser();
    // Asking for a code says nothing about whose number it is...
    await other.session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    // ...only proving you receive its texts does.
    await expectError(
      other.session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "PHONE_NUMBER_TAKEN",
    );
    // Its own number again: nothing to verify.
    await expectError(owner.session.rpc.user.sendPhoneCode({ phoneNumber }), "PHONE_NUMBER_TAKEN");
  });

  it("when two accounts verify the same number at once, the second is refused", async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const phoneNumber = newPhone();
    await first.session.rpc.user.sendPhoneCode({ phoneNumber });
    const firstCode = (await takeNotification(harness, "auth.phone-code", phoneNumber)).data.code;
    await second.session.rpc.user.sendPhoneCode({ phoneNumber });
    const secondCode = (await takeNotification(harness, "auth.phone-code", phoneNumber)).data.code;

    await first.session.rpc.user.verifyPhone({ phoneNumber, code: firstCode });
    await expectError(
      second.session.rpc.user.verifyPhone({ phoneNumber, code: secondCode }),
      "PHONE_NUMBER_TAKEN",
    );
    expect((await second.session.rpc.user.me()).phoneNumber).toBeNull();
  });

  it("of two requests with the right code at once, only one adds the number", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    // In-process, so both pass the attempt count before either claims the code.
    const phone = harness.app.get<PhoneService>(
      (await import("../src/modules/user/phone.service")).PhoneService,
    );
    const results = await Promise.allSettled([
      phone.verify(userId, phoneNumber, data.code),
      phone.verify(userId, phoneNumber, data.code),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "PHONE_CODE_INVALID" },
    });
    expect((await session.rpc.user.me()).phoneNumber).toBe(phoneNumber);
  });

  it("texts and alerts in English when the account's language is no longer offered", async () => {
    const { session, email, password } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    await client
      .query("UPDATE auth.user SET locale = 'fr' WHERE id = $1", [userId])
      .finally(() => client.end());
    // A new session reads the account as it's stored now.
    await session.auth("/sign-in/email", { email, password });
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const text = await takeNotification(harness, "auth.phone-code", phoneNumber);
    expect(text.to.locale).toBe("en");
    await session.rpc.user.verifyPhone({ phoneNumber, code: text.data.code });
    expect((await takeNotification(harness, "auth.security-alert", email)).to.locale).toBe("en");
  });

  it("removing a number when there is none changes nothing and alerts nobody", async () => {
    const { session, email } = await signedInUser();
    const me = await session.rpc.user.me();
    expect((await session.rpc.user.removePhone()).phoneNumber).toBeNull();
    expect(await outboxEvents(me.id)).toEqual([]);
    // An alert is recorded before the request answers: there's nothing to wait for.
    expect(await queuedNotification(harness, "auth.security-alert", email)).toBeUndefined();
  });

  it("a number that can't be saved fails as INTERNAL, not as taken", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const phoneNumber = newPhone();
    await session.rpc.user.sendPhoneCode({ phoneNumber });
    const { data } = await takeNotification(harness, "auth.phone-code", phoneNumber);
    // Another transaction holds the account's row, so the change times out.
    const holder = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM auth.user WHERE id = $1 FOR UPDATE", [userId]);
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber, code: data.code }),
      "INTERNAL",
    ).finally(() => holder.query("ROLLBACK").then(() => holder.end()));
    expect((await session.rpc.user.me()).phoneNumber).toBeNull();
  });

  it("limits texts per account and per number", async () => {
    const { session } = await signedInUser();
    for (let i = 0; i < 5; i++) {
      await session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() });
    }
    const limited = await expectError(
      session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
      "RATE_LIMITED",
    );
    expect(limited.data?.params).toMatchObject({ retryAfterSeconds: expect.any(Number) });

    // Three accounts texting one number (someone spamming a victim) hit the number's limit.
    const victim = newPhone();
    for (let i = 0; i < 3; i++) {
      await (await signedInUser()).session.rpc.user.sendPhoneCode({ phoneNumber: victim });
    }
    await expectError(
      (await signedInUser()).session.rpc.user.sendPhoneCode({ phoneNumber: victim }),
      "RATE_LIMITED",
    );
  });

  it("removing the number audits it and tells the number that was removed", async () => {
    const { session, email } = await signedInUser();
    const me = await session.rpc.user.me();
    const { phoneNumber } = await addPhone(session);
    await takeNotification(harness, "auth.security-alert", email);

    expect((await session.rpc.user.removePhone()).phoneNumber).toBeNull();
    expect(await outboxEvents(me.id)).toEqual(["added", "removed"]);
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert.data.event).toBe("phone-removed");
    expect(alert.to.phone).toBe(phoneNumber);
  });

  it("security alerts are texted to the verified number too", async () => {
    const { session, email, password } = await signedInUser();
    const { phoneNumber } = await addPhone(session);
    await takeNotification(harness, "auth.security-alert", email);
    await session.auth("/change-password", {
      currentPassword: password,
      newPassword: newPassword(),
    });
    const alert = await takeNotification(harness, "auth.security-alert", email);
    expect(alert).toMatchObject({
      data: { event: "password-changed" },
      to: { phone: phoneNumber },
    });
  });

  it("needs a recent sign-in to change the number", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      stored.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    });
    await expectError(
      session.rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: "123456" }),
      "FRESH_SESSION_REQUIRED",
    );
    await expectError(session.rpc.user.removePhone(), "FRESH_SESSION_REQUIRED");
    // Reading it doesn't.
    await expect(session.rpc.user.me()).resolves.toMatchObject({ phoneNumber: null });
  });

  it("rejects numbers that aren't E.164, and requires a session", async () => {
    const { session } = await signedInUser();
    for (const phoneNumber of ["4155550123", "+0123456789", "+1", "+1415555012345678", "phone"]) {
      await expectError(session.rpc.user.sendPhoneCode({ phoneNumber }), "VALIDATION_FAILED");
    }
    await expectError(
      session.rpc.user.verifyPhone({ phoneNumber: newPhone(), code: "12345" }),
      "VALIDATION_FAILED",
    );
    await expectError(
      createSession(harness).rpc.user.sendPhoneCode({ phoneNumber: newPhone() }),
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

describe("push devices", () => {
  const webDevice = (id = randomUUID()) => ({
    platform: "web" as const,
    subscription: {
      endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
      keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    },
  });

  async function deviceRows(userId?: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client.query<{ user_id: string; platform: string; token: string }>(
      userId
        ? "SELECT user_id, platform, token FROM notifications.device WHERE user_id = $1"
        : "SELECT user_id, platform, token FROM notifications.device",
      userId ? [userId] : [],
    );
    await client.end();
    return rows;
  }

  it("tells browsers the VAPID public key to subscribe with", async () => {
    const info = await createSession(harness).rpc.system.info();
    expect(info.webPushPublicKey).toBe("BPublicVapidKeyForTests");
  });

  it("registers native and browser devices once, and removes them", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const ios = { platform: "ios" as const, token: "a1".repeat(32) };
    const android = { platform: "android" as const, token: `fcm:${randomUUID()}` };
    const web = webDevice();

    const first = await session.rpc.notifications.registerDevice({
      device: ios,
      appVersion: "2.1.0",
    });
    // The app registers on every start: same token, same row.
    expect(await session.rpc.notifications.registerDevice({ device: ios })).toEqual(first);
    await session.rpc.notifications.registerDevice({ device: android });
    await session.rpc.notifications.registerDevice({ device: web });
    const rows = await deviceRows(me.id);
    expect(rows.map((row) => row.platform).sort()).toEqual(["android", "ios", "web"]);
    // Browser subscriptions are stored in one canonical form (key order fixed).
    expect(rows.find((row) => row.platform === "web")?.token).toBe(
      JSON.stringify({
        endpoint: web.subscription.endpoint,
        keys: { p256dh: web.subscription.keys.p256dh, auth: web.subscription.keys.auth },
      }),
    );

    await session.rpc.notifications.unregisterDevice({
      device: {
        ...web,
        subscription: { keys: web.subscription.keys, endpoint: web.subscription.endpoint },
      },
    });
    await session.rpc.notifications.unregisterDevice({ device: ios });
    expect((await deviceRows(me.id)).map((row) => row.platform)).toEqual(["android"]);
  });

  it("moves a device to whoever signs in on it, and one user can't remove another's", async () => {
    const device = { platform: "android" as const, token: `fcm:${randomUUID()}` };
    const first = await signedInUser();
    const second = await signedInUser();
    const firstId = (await first.session.rpc.user.me()).id;
    const secondId = (await second.session.rpc.user.me()).id;

    await first.session.rpc.notifications.registerDevice({ device });
    // Removing is scoped to the caller's own devices.
    await second.session.rpc.notifications.unregisterDevice({ device });
    expect((await deviceRows(firstId)).map((row) => row.token)).toEqual([device.token]);

    // The same phone, now signed in as someone else.
    await second.session.rpc.notifications.registerDevice({ device });
    expect(await deviceRows(firstId)).toEqual([]);
    expect((await deviceRows(secondId)).map((row) => row.token)).toEqual([device.token]);
  });

  it("keeps the 20 devices seen most recently", async () => {
    const { session } = await signedInUser();
    const me = await session.rpc.user.me();
    const tokens = Array.from({ length: 22 }, (_, i) => `fcm:${i}-${randomUUID()}`);
    for (const token of tokens) {
      await session.rpc.notifications.registerDevice({ device: { platform: "android", token } });
    }
    const kept = (await deviceRows(me.id)).map((row) => row.token).sort();
    expect(kept).toEqual(tokens.slice(2).sort());
  });

  it("rejects subscriptions that aren't a browser push service, and malformed tokens", async () => {
    const { session } = await signedInUser();
    for (const endpoint of [
      "https://169.254.169.254/latest/meta-data",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.attacker.dev/x",
      "https://localhost:3001/api/v1/system",
    ]) {
      await expectError(
        session.rpc.notifications.registerDevice({
          device: { platform: "web", subscription: { endpoint, keys: { p256dh: "k", auth: "a" } } },
        }),
        "VALIDATION_FAILED",
      );
    }
    await expectError(
      session.rpc.notifications.registerDevice({
        device: { platform: "ios", token: "../../3/device/evil" },
      }),
      "VALIDATION_FAILED",
    );
    await expectError(
      session.rpc.notifications.registerDevice({
        device: { platform: "android", token: "has spaces and / slashes" },
      }),
      "VALIDATION_FAILED",
    );
    expect(await deviceRows((await session.rpc.user.me()).id)).toEqual([]);
  });

  it("stops pushing to a device when its session signs out or is revoked", async () => {
    const { session: laptop, email, password } = await signedInUser();
    const me = await laptop.rpc.user.me();
    const phone = createSession(harness);
    await phone.auth("/sign-in/email", { email, password });
    const tablet = createSession(harness);
    await tablet.auth("/sign-in/email", { email, password });
    const token = (name: string) => `fcm:${name}-${me.id}`;
    await laptop.rpc.notifications.registerDevice({ device: webDevice() });
    await phone.rpc.notifications.registerDevice({
      device: { platform: "android", token: token("phone") },
    });
    await tablet.rpc.notifications.registerDevice({
      device: { platform: "android", token: token("tablet") },
    });
    expect(await deviceRows(me.id)).toHaveLength(3);

    await phone.auth("/sign-out");
    expect((await deviceRows(me.id)).map((row) => row.token)).not.toContain(token("phone"));

    // Revoked from the laptop: the tablet's device goes with its session.
    await laptop.auth("/revoke-other-sessions");
    expect((await deviceRows(me.id)).map((row) => row.platform)).toEqual(["web"]);
  });

  it("an admin impersonating the user can't register their own device", async () => {
    const { session } = await signedInUser();
    await editSession(harness, session, (stored) => {
      (stored as { impersonatedBy?: string }).impersonatedBy = randomUUID();
    });
    await expectError(
      session.rpc.notifications.registerDevice({ device: webDevice() }),
      "FORBIDDEN",
    );
  });

  it("requires a session", async () => {
    await expectError(
      createSession(harness).rpc.notifications.registerDevice({ device: webDevice() }),
      "UNAUTHENTICATED",
    );
  });

  it("the database function only registers for the user the transaction is scoped to", async () => {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await client.connect();
    await expect(
      client.query(
        "SELECT notifications.register_device('android', 'fcm:unscoped', null, gen_random_uuid())",
      ),
    ).rejects.toThrow(/app.user_id/);
    // Scoped to one user, with another user's session.
    const victim = await signedInUser();
    const attacker = await signedInUser();
    const [victimSession] = (
      await client.query<{ id: string }>("SELECT id FROM auth.session WHERE user_id = $1", [
        (await victim.session.rpc.user.me()).id,
      ])
    ).rows;
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      (await attacker.session.rpc.user.me()).id,
    ]);
    await expect(
      client.query("SELECT notifications.register_device('android', 'fcm:stolen', null, $1)", [
        victimSession?.id,
      ]),
    ).rejects.toThrow(/is not the user's/);
    await client.query("ROLLBACK");
    await client.end();
    const notifications = new pg.Client({
      connectionString: harness.testDb.urlFor("app_notifications"),
    });
    await notifications.connect();
    await expect(
      notifications.query(
        "SELECT notifications.register_device('android', 'fcm:x', null, gen_random_uuid())",
      ),
    ).rejects.toThrow(/permission denied/);
    await notifications.end();
  });
});

describe("account deletion", () => {
  /** Counts an organization's todos and reports whether the org still exists (as the migrator). */
  async function orgState(orgId: string) {
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("migrator") });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const todos = await client.query<{ count: string; created: string }>(
        "SELECT count(*) AS count, count(created_by_id) AS created FROM app.todo",
      );
      const org = await client.query("SELECT 1 FROM auth.organization WHERE id = $1", [orgId]);
      await client.query("COMMIT");
      return {
        exists: org.rowCount === 1,
        todos: Number(todos.rows[0]?.count),
        withCreator: Number(todos.rows[0]?.created),
      };
    } finally {
      await client.end();
    }
  }

  it("removes the personal workspace and its data", async () => {
    const { session, password } = await signedInUser();
    await session.rpc.todo.create({ title: "Private" });
    const orgId = required(
      (await session.rpc.user.me()).activeOrganizationId,
      "the active workspace",
    );
    expect(await orgState(orgId)).toMatchObject({ exists: true, todos: 1 });

    expect((await session.auth("/delete-user", { password })).status).toBe(200);
    expect(await orgState(orgId)).toEqual({ exists: false, todos: 0, withCreator: 0 });
  });

  it("won't leave a shared workspace without an owner, and keeps its data", async () => {
    const owner = await signedInUser();
    const member = await signedInUser();
    const team = await owner.session.auth<{ id: string }>("/organization/create", {
      name: "Team",
      slug: `team-${randomUUID().slice(0, 8)}`,
    });
    await owner.session.auth("/organization/invite-member", {
      email: member.email,
      role: "member",
      organizationId: team.body.id,
    });
    const invitation = await takeNotification(harness, "org.invitation", member.email);
    const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
    expect(
      (await member.session.auth("/organization/accept-invitation", { invitationId })).status,
    ).toBe(200);
    await owner.session.auth("/organization/set-active", { organizationId: team.body.id });
    await owner.session.rpc.todo.create({ title: "Team work" });

    const blocked = await owner.session.auth<{ code: string }>("/delete-user", {
      password: owner.password,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("ORGANIZATION_NEEDS_OWNER");

    const { id: memberUserId } = await member.session.rpc.user.me();
    const { members } = await owner.session.authGet<{ members: { id: string; userId: string }[] }>(
      `/organization/list-members?organizationId=${team.body.id}`,
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
    // The team and its todo survive; the todo just no longer names its creator.
    expect(await orgState(team.body.id)).toEqual({ exists: true, todos: 1, withCreator: 0 });
  });
});

describe("events outside a request", () => {
  it("name the workspace the change happened in, from a job, script or seed as from a request", async () => {
    const { session } = await signedInUser();
    const { id: userId } = await session.rpc.user.me();
    const [personal] = await session.authGet<{ id: string }[]>("/organization/list");
    const orgId = orgIdSchema.parse(personal?.id);
    const { TodoService } = await import("../src/modules/todo");
    // Called directly: no request, so no organization in the request context.
    const todo = await harness.app.get(TodoService).create(orgId, userId, "From a job");
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client
      .query<{ org_id: string | null }>(
        "SELECT org_id FROM app.outbox_event WHERE name = 'todo.created.v1' AND key = $1",
        [todo.id],
      )
      .finally(() => client.end());
    expect(rows).toEqual([{ org_id: orgId }]);
  });
});

describe("todos", () => {
  it("creates, pages, completes and deletes, with typed errors", async () => {
    const { session } = await signedInUser();
    const created = [];
    for (const title of ["one", "two", "three"]) {
      created.push(await session.rpc.todo.create({ title }));
    }
    expect(created[0]?.createdAt).toBeInstanceOf(Date);

    const first = await session.rpc.todo.list({ limit: 2 });
    expect(first.items.map((todo) => todo.title)).toEqual(["three", "two"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await session.rpc.todo.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((todo) => todo.title)).toEqual(["one"]);
    expect(second.nextCursor).toBeNull();

    const todo = created[0];
    if (!todo) {
      throw new Error("no todo");
    }
    const done = await session.rpc.todo.setCompleted({
      id: todo.id,
      completed: true,
      version: todo.version,
    });
    expect(done).toMatchObject({ completed: true, version: todo.version + 1 });
    // A second writer holding the old version is told, instead of silently overwriting.
    await expectError(
      session.rpc.todo.setCompleted({ id: todo.id, completed: false, version: todo.version }),
      "TODO_VERSION_CONFLICT",
    );

    await session.rpc.todo.delete({ id: todo.id });
    await expectError(session.rpc.todo.delete({ id: todo.id }), "TODO_NOT_FOUND");
  });

  it("returns validation problems as codes, never English messages", async () => {
    const { session } = await signedInUser();
    const error = await expectError(session.rpc.todo.create({ title: "   " }), "VALIDATION_FAILED");
    expect(error.data.issues).toEqual([{ path: ["title"], code: "too_small" }]);
  });

  it("refuses a version the database can't hold, instead of failing on it", async () => {
    const { session } = await signedInUser();
    const todo = await session.rpc.todo.create({ title: "versioned" });
    const error = await expectError(
      session.rpc.todo.setCompleted({ id: todo.id, completed: true, version: 2 ** 31 }),
      "VALIDATION_FAILED",
    );
    expect(error.data.issues).toEqual([{ path: ["version"], code: "too_big" }]);
  });

  it("keeps organizations apart", async () => {
    const alice = (await signedInUser()).session;
    const bob = (await signedInUser()).session;
    const secret = await alice.rpc.todo.create({ title: "alice's plan" });

    expect((await bob.rpc.todo.list({ limit: 20 })).items).toEqual([]);
    await expectError(bob.rpc.todo.delete({ id: secret.id }), "TODO_NOT_FOUND");
    await expectError(
      bob.rpc.todo.setCompleted({ id: secret.id, completed: true, version: 1 }),
      "TODO_NOT_FOUND",
    );
    expect((await alice.rpc.todo.list({ limit: 20 })).items).toHaveLength(1);
  });

  it("records a domain event in the same transaction as each change", async () => {
    const { session } = await signedInUser();
    const todo = await session.rpc.todo.create({ title: "evented" });
    const { createDb } = await import("@repo/db");
    const migrator = createDb({
      url: harness.testDb.urlFor("migrator"),
      poolMax: 1,
      service: "test",
    });
    const events = await migrator.appOutboxEvent.findMany({ where: { key: todo.id } });
    await migrator.$disconnect();
    expect(events.map((event) => event.name)).toEqual(["todo.created.v1"]);
    // The request's own id (a new UUID: the test's client isn't a trusted proxy).
    expect(events[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("records completing a todo, not reopening it", async () => {
    const { session } = await signedInUser();
    const todo = await session.rpc.todo.create({ title: "back and forth" });
    const done = await session.rpc.todo.setCompleted({
      id: todo.id,
      completed: true,
      version: todo.version,
    });
    await session.rpc.todo.setCompleted({ id: todo.id, completed: false, version: done.version });
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
    await client.connect();
    const { rows } = await client
      .query("SELECT name FROM app.outbox_event WHERE key = $1 ORDER BY id", [todo.id])
      .finally(() => client.end());
    expect(rows.map((row) => row.name)).toEqual(["todo.created.v1", "todo.completed.v1"]);
  });
});

describe("the REST API's reference", () => {
  it("serves the OpenAPI document, and a page to read it outside production", async () => {
    const spec = await fetch(`${harness.baseUrl}/api/v1/openapi.json`);
    expect(spec.status).toBe(200);
    expect(((await spec.json()) as { info: object }).info).toMatchObject({
      title: "Boilerplate API",
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
