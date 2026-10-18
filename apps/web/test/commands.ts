/**
 * What a browser test asks Node to do (`commands.<name>()` from `vitest/browser`), for
 * the few things a page can't: read the codes the API queued for the notification
 * service, set data up in the database, drive the browser itself (cookies, client IP,
 * a virtual passkey authenticator) and catch full-page navigations.
 */
import { randomInt } from "node:crypto";
import type { NotificationPayload } from "@repo/jobs";
import { totp as totpCode } from "@repo/testing/totp";
import { symmetricEncrypt } from "better-auth/crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import type { CDPSession, Page, Request, Route } from "playwright";
import type { BrowserCommand } from "vitest/node";
// The API's own token format (a relative import: nest-common's entry pulls in Nest).
import { createStorage } from "../../../packages/nest-common/src/storage";
import { API, REDIS_URL, SITE, services } from "./services";
import { FAKE_TURNSTILE } from "./turnstile";

/** Full-page navigations each page tried since its test started, in order. */
const navigations = new WeakMap<Page, string[]>();

/** How the Turnstile script answers on each page: the stand-in, blocked, or broken. */
const turnstileModes = new WeakMap<Page, "fake" | "blocked" | "empty" | "held">();

/**
 * Every test starts signed out, from a client IP of its own (the API rate-limits auth
 * per IP and trusts X-Forwarded-For from loopback), with full-page navigations caught:
 * the test page would otherwise leave for the sign-in page. They
 * are answered 204 No Content, which browsers treat as "stay where you are".
 */
const startTest: BrowserCommand<[]> = async ({ page, context }) => {
  await context.clearCookies();
  const ip = `10.${randomInt(250)}.${randomInt(250)}.${randomInt(1, 250)}`;
  clientIps.set(page, ip);
  await page.setExtraHTTPHeaders({ "x-forwarded-for": ip });
  turnstileModes.set(page, "fake");
  failing.set(page, []);
  if (!navigations.has(page)) {
    await page.route("https://challenges.cloudflare.com/turnstile/**", async (route) => {
      // Held: answered once the test picks another mode (a slow network, under control).
      while (turnstileModes.get(page) === "held") {
        await new Promise((r) => setTimeout(r, 20));
      }
      const mode = turnstileModes.get(page);
      if (mode === "blocked") {
        return route.abort();
      }
      return route.fulfill({
        contentType: "text/javascript",
        body: mode === "empty" ? "" : FAKE_TURNSTILE,
      });
    });
    await page.route(
      // Not vitest's own pages: the runner loads each test file at /?sessionId=….
      (url) =>
        !url.pathname.startsWith("/__vitest") &&
        !url.pathname.startsWith("/@") &&
        !url.searchParams.has("sessionId"),
      (route) => {
        const request = route.request();
        const failure = failing.get(page)?.find(({ part }) => request.url().includes(part));
        if (failure) {
          failure.hits += 1;
          if (!failure.status) {
            return route.abort();
          }
          return failure.body === undefined
            ? route.fulfill({ status: failure.status, body: "" })
            : route.fulfill({
                status: failure.status,
                contentType: "application/json",
                body: JSON.stringify(failure.body),
              });
        }
        if (!request.isNavigationRequest() || request.frame() === page.mainFrame()) {
          return route.fallback();
        }
        navigations.get(page)?.push(request.url());
        return route.fulfill({ status: 204 });
      },
    );
  }
  navigations.set(page, []);
  if (!finished.has(page)) {
    page.on("request", (request) => started.get(page)?.add(request));
    // Only this test's own: a request the last test left in flight is answered during
    // this one, and would satisfy a wait before this test's page did anything.
    page.on("requestfinished", (request) => {
      if (started.get(page)?.has(request)) {
        finished.get(page)?.push(request.url());
      }
    });
  }
  started.set(page, new WeakSet());
  finished.set(page, []);
};

/** The page's requests sent since its test started, and those answered, by URL. */
const started = new WeakMap<Page, WeakSet<Request>>();
const finished = new WeakMap<Page, string[]>();

/** How many of the page's requests to URLs containing `part` have been answered. */
const answeredRequests: BrowserCommand<[part: string]> = ({ page }, part) =>
  finished.get(page)?.filter((url) => url.includes(part)).length ?? 0;

/** Each page's client IP for its current test, and the requests it makes fail. */
const clientIps = new WeakMap<Page, string>();
const failing = new WeakMap<
  Page,
  { part: string; status?: number; body?: unknown; hits: number }[]
>();

/** Sends these headers with the page's requests for the rest of the test (an app version, say). */
const requestHeaders: BrowserCommand<[headers: Record<string, string>]> = async (
  { page },
  headers,
) => {
  await page.setExtraHTTPHeaders({ ...headers, "x-forwarded-for": clientIps.get(page) ?? "" });
};

/**
 * Makes the page's requests to URLs containing `part` fail for the rest of the test: as
 * if the network dropped them, or with `status` (a gateway's 502 when the API is down)
 * and, if given, `body` as JSON (a refusal the local stack can't produce).
 * Returns nothing; `failedRequests(part)` says how many there have been.
 */
const failRequests: BrowserCommand<
  [part: string, options?: { status?: number; body?: unknown }]
> = ({ page }, part, options = {}) => {
  failing.get(page)?.push({ part, ...options, hits: 0 });
};

const failedRequests: BrowserCommand<[part: string]> = ({ page }, part) =>
  failing
    .get(page)
    ?.filter((failure) => failure.part === part)
    .reduce((total, failure) => total + failure.hits, 0) ?? 0;

/** The full-page navigations the page tried since the test started. */
const hardNavigations: BrowserCommand<[]> = ({ page }) => navigations.get(page) ?? [];

async function sqlRows<T>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: (await services()).databaseUrl });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Notification requests (outbox rows) already handed to a test. */
const takenRequests = new Set<string>();

/**
 * The data of the email the API queued for `address`: a one-time code or a security
 * alert. Waits up to five seconds.
 */
const takeNotification: BrowserCommand<[template: string, address: string]> = async (
  _context,
  template,
  address,
) => {
  const matches = (payload: NotificationPayload) =>
    payload.template === template && payload.to.email === address;
  // The prefix @repo/jobs gives every queue (queuePrefix).
  const critical = new Queue("notifications-critical", {
    connection: { url: REDIS_URL },
    prefix: "{notifications-critical}",
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const jobs = await critical.getJobs(["waiting", "delayed", "prioritized"]);
      for (const job of jobs.reverse()) {
        const { payload } = job.data as { payload: NotificationPayload };
        if (matches(payload)) {
          await job.remove();
          return payload.data;
        }
      }
      // Security alerts leave through the outbox instead, which no relay drains here.
      const rows = await sqlRows<{ id: string; payload: { notification: NotificationPayload } }>(
        "SELECT id::text, payload FROM app.outbox_event WHERE name = 'notification.requested.v1' ORDER BY id DESC",
      );
      const request = rows.find(
        (row) => !takenRequests.has(row.id) && matches(row.payload.notification),
      );
      if (request) {
        takenRequests.add(request.id);
        return request.payload.notification.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${template} queued for ${address}`);
  } finally {
    await critical.close();
  }
};

/** Runs SQL on the tests' database as its owner: data the UI can't create, or time passing. */
const sql: BrowserCommand<[query: string, params?: unknown[]]> = (_context, query, params) =>
  sqlRows(query, params);

/**
 * A virtual platform authenticator (Chrome DevTools Protocol) standing in for Touch ID
 * or Windows Hello. `present: false` makes it refuse, as when the user closes the
 * browser's passkey prompt.
 */
const authenticators = new WeakMap<Page, { cdp: CDPSession; id: string }>();
const virtualAuthenticator: BrowserCommand<[options?: { verified?: boolean }]> = async (
  { page, context },
  options = {},
) => {
  const existing = authenticators.get(page);
  if (existing) {
    await existing.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: existing.id,
    });
  }
  const cdp = existing?.cdp ?? (await context.newCDPSession(page));
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: options.verified ?? true,
      automaticPresenceSimulation: true,
    },
  });
  authenticators.set(page, { cdp, id: authenticatorId });
};

/**
 * How Turnstile's script loads for the rest of the test: the stand-in (the default),
 * blocked (an extension, or offline), loading without defining the widget, or held
 * until the test sets another mode.
 */
const turnstile: BrowserCommand<[mode: "fake" | "blocked" | "empty" | "held"]> = (
  { page },
  mode,
) => {
  turnstileModes.set(page, mode);
};

/** The code an authenticator app shows for `secret` now. */
const totp: BrowserCommand<[secret: string]> = (_context, secret) => totpCode(secret);

/**
 * Changes the page's stored session in place: `createdAt` (to make it older than the
 * API's fresh-session window, as if the tab had been left open), what it recorded about
 * the device, or the user it caches (a value saved before the app changed, say).
 * Sessions live in Redis (better-auth's secondary storage, "auth:" keys).
 */
const editSession: BrowserCommand<
  [fields: Record<string, unknown>, userFields?: Record<string, unknown>]
> = async ({ context }, fields, userFields = {}) => {
  const cookie = (await context.cookies()).find((c) => c.name === "better-auth.session_token");
  if (!cookie) {
    throw new Error("not signed in");
  }
  const key = `auth:${decodeURIComponent(cookie.value).split(".")[0]}`;
  const redis = new Redis(REDIS_URL);
  try {
    const stored = JSON.parse((await redis.get(key)) ?? "null") as {
      session: Record<string, unknown>;
      user: Record<string, unknown>;
    } | null;
    if (!stored) {
      throw new Error(`no session at ${key}`);
    }
    Object.assign(stored.session, fields);
    Object.assign(stored.user, userFields);
    await redis.set(key, JSON.stringify(stored), "KEEPTTL");
  } finally {
    redis.disconnect();
  }
};

/** The page's session signed in three hours ago: "sudo mode" actions need a new sign-in. */
const ageSession: BrowserCommand<[]> = (context) =>
  editSession(context, { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });

/**
 * Signs the user in on another device (a request from Node with that device's user
 * agent), from a client IP of its own, or with none at all.
 */
const signInElsewhere: BrowserCommand<
  [email: string, password: string, userAgent: string, options?: { withoutIp?: boolean }]
> = async ({ project }, email, password, userAgent, options = {}) => {
  const variant = project.name.includes("features off") ? "bare" : "full";
  const response = await fetch(`${API[variant].url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: SITE[variant].url,
      "user-agent": userAgent,
      ...(!options.withoutIp && {
        "x-forwarded-for": `10.${randomInt(250)}.${randomInt(250)}.${randomInt(1, 250)}`,
      }),
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(`sign-in answered ${response.status}`);
  }
};

/**
 * The next PUT to a URL containing `part` is answered with `status`, as when storage
 * refuses an upload; later requests go through again.
 */
const refuseNextPut: BrowserCommand<[part: string, status: number]> = async (
  { page },
  part,
  status,
) => {
  const matches = (url: URL) => url.href.includes(part);
  const handler = async (route: Route) => {
    if (route.request().method() !== "PUT") {
      return route.fallback();
    }
    await page.unroute(matches, handler);
    return route.fulfill({ status, headers: { "access-control-allow-origin": "*" } });
  };
  await page.route(matches, handler);
};

/**
 * Lets the test page upload to the local object storage. Its bucket allows the dev site's
 * origin only (docker-compose.yml, s3-init), not the test pages' port, so requests to it
 * are sent from Node instead, to the same presigned URL, and answered with the CORS
 * headers the bucket gives the real site. What storage does with them is unchanged.
 */
const withStorageCors = new WeakSet<Page>();
const storageCors: BrowserCommand<[]> = async ({ page }) => {
  if (withStorageCors.has(page)) {
    return;
  }
  withStorageCors.add(page);
  const storage = new URL(process.env.S3_ENDPOINT ?? "http://localhost:59000").host;
  await page.route(
    (url) => url.host === storage,
    async (route) => {
      const origin = route.request().headers().origin ?? "*";
      const cors = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "PUT, GET",
        "access-control-allow-headers": "*",
        "access-control-expose-headers": "ETag",
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: cors });
      }
      const response = await route.fetch();
      return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    },
  );
};

/**
 * Publishes a realtime message the way the worker does after an outbox event (no worker
 * runs here): `channel` is `user:<id>` or `org:<id>` (realtimeChannel in contracts).
 */
const publishRealtime: BrowserCommand<[channel: string, message: { type: string }]> = async (
  _context,
  channel,
  message,
) => {
  const redis = new Redis(REDIS_URL);
  try {
    await redis.publish(`realtime:${channel}`, JSON.stringify(message));
  } finally {
    redis.disconnect();
  }
};

/**
 * What apps/worker does with an upload once it has checked it (it isn't running here):
 * accepted, the bytes leave quarantine and the file is ready; refused, it says why.
 */
const checkUpload: BrowserCommand<[fileId: string, rejectReason?: string]> = async (
  _context,
  fileId,
  rejectReason,
) => {
  if (rejectReason) {
    await sqlRows(
      "UPDATE files.file SET status = 'rejected', reject_reason = $2, updated_at = now() WHERE id = $1",
      [fileId, rejectReason],
    );
    return;
  }
  const storage = createStorage({
    STORAGE_PROVIDER: "s3",
    S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
    S3_REGION: process.env.S3_REGION ?? "us-east-1",
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: true,
  });
  await storage?.move(`quarantine/${fileId}`, `files/${fileId}`);
  await sqlRows(
    `UPDATE files.file SET status = 'ready', content_type = declared_type, size = declared_size,
       ready_at = now(), updated_at = now() WHERE id = $1`,
    [fileId],
  );
};

/**
 * What the AI stand-in's Director answers for the short `videoId` (test/fake-ai.ts): its
 * plan (merged over an id and timestamps), the member's takes and cuts, and the scene check.
 */
const fakeDirector: BrowserCommand<
  [videoId: string, state: { plan?: object; takes?: object[]; cuts?: object[]; scene?: object }]
> = async (_context, videoId, state) => {
  const response = await fetch(`${(await services()).aiUrl}/__fake/director/${videoId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!response.ok) {
    throw new Error(`the AI stand-in answered ${response.status}`);
  }
};

/**
 * What the AI stand-in answers as the workspace `orgId`'s library (test/fake-ai.ts): its
 * plans (each merged over an id and timestamps, and served as its short's plan too),
 * whether the member has indexed their own, and the refusal indexing a new short gets.
 */
const fakeLibrary: BrowserCommand<
  [
    orgId: string,
    state: {
      templates?: object[];
      indexUsed?: boolean;
      indexError?: { status: number; code: string };
    },
  ]
> = async (_context, orgId, state) => {
  const response = await fetch(`${(await services()).aiUrl}/__fake/library/${orgId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!response.ok) {
    throw new Error(`the AI stand-in answered ${response.status}`);
  }
};

/** A cut as the AI stand-in answers it, and the YouTube post Gemini writes for it. */
const fakeCut: BrowserCommand<[cutId: string, state: { cut: object; copy?: object }]> = async (
  _context,
  cutId,
  state,
) => {
  const response = await fetch(`${(await services()).aiUrl}/__fake/cuts/${cutId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!response.ok) {
    throw new Error(`the AI stand-in answered ${response.status}`);
  }
};

const YOUTUBE_UPLOAD = "https://www.googleapis.com/auth/youtube.upload";

/**
 * Links a Google account allowed to upload to YouTube to the user, as consenting in
 * the publish sheet would: the mock Google's consent and token exchange give its tokens,
 * stored the way better-auth stores them (encrypted with BETTER_AUTH_SECRET, which the
 * full API shares with this process).
 */
const linkYouTube: BrowserCommand<[userId: string, email: string]> = async (
  _context,
  userId,
  email,
) => {
  const { googleUrl } = await services();
  const authorize = new URL(`${googleUrl}/o/oauth2/v2/auth`);
  for (const [name, value] of Object.entries({
    client_id: "web-tests.apps.googleusercontent.com",
    redirect_uri: "http://localhost/callback",
    response_type: "code",
    login_hint: email,
    scope: `openid email profile ${YOUTUBE_UPLOAD}`,
  })) {
    authorize.searchParams.set(name, value);
  }
  const consent = await fetch(authorize, { redirect: "manual" });
  const code = new URL(String(consent.headers.get("location"))).searchParams.get("code");
  const tokens = (await (
    await fetch(`${googleUrl}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: String(code) }),
    })
  ).json()) as { access_token: string; refresh_token: string; scope: string };
  const encrypted = (data: string) =>
    symmetricEncrypt({ key: String(process.env.BETTER_AUTH_SECRET), data });
  await sqlRows(
    `INSERT INTO auth.account (account_id, provider_id, user_id, access_token, refresh_token,
                               access_token_expires_at, scope, updated_at)
     VALUES ($1, 'google', $2, $3, $4, now() + interval '1 hour', $5, now())`,
    [
      email,
      userId,
      await encrypted(tokens.access_token),
      await encrypted(tokens.refresh_token),
      tokens.scope.split(" ").join(","),
    ],
  );
};

/** Writes a file's bytes into the tests' object storage, where the API reads it from. */
const storeFile: BrowserCommand<[key: string, base64: string, contentType: string]> = async (
  _context,
  key,
  base64,
  contentType,
) => {
  const storage = createStorage({
    STORAGE_PROVIDER: "s3",
    S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
    S3_REGION: process.env.S3_REGION ?? "us-east-1",
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: true,
  });
  await storage?.write(key, Buffer.from(base64, "base64"), contentType);
};

export const commands = {
  answeredRequests,
  fakeCut,
  linkYouTube,
  storeFile,
  fakeLibrary,
  checkUpload,
  fakeDirector,
  publishRealtime,
  editSession,
  storageCors,
  refuseNextPut,
  signInElsewhere,
  ageSession,
  requestHeaders,
  failRequests,
  failedRequests,
  totp,
  startTest,
  hardNavigations,
  takeNotification,
  sql,
  virtualAuthenticator,
  turnstile,
};

declare module "vitest/browser" {
  interface BrowserCommands {
    answeredRequests(part: string): Promise<number>;
    checkUpload(fileId: string, rejectReason?: string): Promise<void>;
    fakeCut(cutId: string, state: { cut: object; copy?: object }): Promise<void>;
    linkYouTube(userId: string, email: string): Promise<void>;
    storeFile(key: string, base64: string, contentType: string): Promise<void>;
    fakeDirector(
      videoId: string,
      state: { plan?: object; takes?: object[]; cuts?: object[]; scene?: object },
    ): Promise<void>;
    fakeLibrary(
      orgId: string,
      state: {
        templates?: object[];
        indexUsed?: boolean;
        indexError?: { status: number; code: string };
      },
    ): Promise<void>;
    publishRealtime(channel: string, message: { type: string }): Promise<void>;
    storageCors(): Promise<void>;
    refuseNextPut(part: string, status: number): Promise<void>;
    signInElsewhere(
      email: string,
      password: string,
      userAgent: string,
      options?: { withoutIp?: boolean },
    ): Promise<void>;
    ageSession(): Promise<void>;
    editSession(
      fields: Record<string, unknown>,
      userFields?: Record<string, unknown>,
    ): Promise<void>;
    startTest(): Promise<void>;
    requestHeaders(headers: Record<string, string>): Promise<void>;
    failRequests(part: string, options?: { status?: number; body?: unknown }): Promise<void>;
    failedRequests(part: string): Promise<number>;
    totp(secret: string): Promise<string>;
    hardNavigations(): Promise<string[]>;
    takeNotification<T = Record<string, unknown>>(template: string, address: string): Promise<T>;
    sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
    virtualAuthenticator(options?: { verified?: boolean }): Promise<void>;
    turnstile(mode: "fake" | "blocked" | "empty" | "held"): Promise<void>;
  }
}
