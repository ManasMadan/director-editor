/**
 * Boots the real API in-process against an isolated database (cloned from the migrated
 * template) and its own Redis database index, and gives tests a typed oRPC client plus a
 * cookie-aware HTTP helper for better-auth endpoints.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@repo/contracts/api";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { type NotificationPayload, parseJob, queuePrefix } from "@repo/jobs";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";

export interface Harness {
  baseUrl: string;
  /** The application itself, for tests that call its services directly. */
  app: NestFastifyApplication;
  redis: Redis;
  testDb: TestDatabase;
  close(): Promise<void>;
}

const OPTIONAL_FEATURES_OFF = {
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  TURNSTILE_SITE_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  S3_BUCKET: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_PRICE_PRO_MONTHLY: "",
  STRIPE_PRICE_PRO_YEARLY: "",
  STRIPE_API_URL: "",
  AI_URL: "",
  AI_SERVICE_SECRET: "",
};

/** Local object storage (docker compose --profile files); CI runs the same. */
export const LOCAL_STORAGE = {
  S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:59000",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "rustfs",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "rustfs-secret",
  S3_FORCE_PATH_STYLE: "true",
};

/**
 * Starts the API in-process against a fresh database. `redisDb` is the Redis database for
 * this test file alone (see redisDatabase): files run in parallel, and each API's queue
 * consumers and Redis flush must not touch another file's.
 */
export async function startApi(
  redisDb: number,
  env: Record<string, string> = {},
): Promise<Harness> {
  const testDb = await createTestDatabase();
  Object.assign(process.env, {
    // Optional features start off, whatever the environment says (a shell can still export
    // .env's values); a test turns on what it exercises.
    ...OPTIONAL_FEATURES_OFF,
    // Several test files each run an API on this machine at once.
    LOAD_SHEDDING: "off",
    API_DATABASE_URL: testDb.urlFor("app_api"),
    // A private Redis database: queued jobs and sessions never mix with local dev.
    REDIS_URL: redisDatabase(redisDb),
    ...env,
  });
  const redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  await flushTestDatabase(redis);
  const { createApiServer } = await import("../src/server");
  const app: NestFastifyApplication = await createApiServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.getHttpServer().address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    app,
    redis,
    testDb,
    async close() {
      await app.close();
      await redis.quit();
      await testDb.drop();
    },
  };
}

/** A browser-like session: cookies, origin and a unique client IP (rate limits are per IP). */
export function createSession(
  harness: Harness,
  options: { locale?: string; appVersion?: string } = {},
) {
  let cookies = new Map<string, string>();
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const headers = () => ({
    origin: process.env.WEB_URL ?? "http://localhost:3000",
    "x-forwarded-for": ip,
    ...(options.locale && { "accept-language": options.locale }),
    ...(options.appVersion && { "x-app-version": options.appVersion }),
    ...(cookies.size && {
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    }),
  });
  const store = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      if (!name) {
        continue;
      }
      const value = rest.join("=");
      if (value === "" || /max-age=0/i.test(cookie)) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
  };

  return {
    ip,
    async auth<T = unknown>(path: string, body: unknown = {}) {
      const response = await fetch(`${harness.baseUrl}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify(body),
      });
      store(response);
      return { status: response.status, body: (await response.json().catch(() => null)) as T };
    },
    async authGet<T = unknown>(path: string): Promise<T> {
      const response = await fetch(`${harness.baseUrl}/api/auth${path}`, { headers: headers() });
      store(response);
      return (await response.json()) as T;
    },
    rpc: createORPCClient<ContractRouterClient<Contract>>(
      new RPCLink({
        url: `${harness.baseUrl}/rpc`,
        headers,
        fetch: async (request, init) => {
          const response = await fetch(request, init);
          store(response);
          return response;
        },
      }),
    ),
    cookies: () => new Map(cookies),
    useCookies: (next: Map<string, string>) => {
      cookies = new Map(next);
    },
  };
}

/** Notification requests (outbox rows) already handed to a test, by event id. */
const takenRequests = new Set<string>();

type Notification<T extends NotificationPayload["template"]> = Extract<
  NotificationPayload,
  { template: T }
>;

/**
 * Takes the first notification queued (no worker runs in these tests) or requested
 * through the outbox that matches, if there is one now.
 */
async function findNotification<T extends NotificationPayload["template"]>(
  template: T,
  /** The email address or phone number it's sent to. */
  address: string,
  { queue, database }: { queue: Queue; database: pg.Client },
): Promise<Notification<T> | undefined> {
  const matches = (payload: NotificationPayload) => {
    const to = payload.to as { email?: string; phone?: string };
    return payload.template === template && (to.email === address || to.phone === address);
  };
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);
  for (const job of jobs.reverse()) {
    const { payload } = parseJob("notifications-critical", "send", job.data);
    if (matches(payload)) {
      await job.remove();
      return payload as Notification<T>;
    }
  }
  // Security alerts leave through the outbox instead (notification.requested.v1), which
  // no relay drains here: they're read from its table.
  const { rows } = await database.query<{
    id: string;
    payload: { notification: NotificationPayload };
  }>(
    "SELECT id::text, payload FROM app.outbox_event WHERE name = 'notification.requested.v1' ORDER BY id DESC",
  );
  const request = rows.find(
    (row) => !takenRequests.has(row.id) && matches(row.payload.notification),
  );
  if (!request) {
    return undefined;
  }
  takenRequests.add(request.id);
  return request.payload.notification as Notification<T>;
}

async function withNotifications<R>(
  harness: Harness,
  use: (sources: { queue: Queue; database: pg.Client }) => Promise<R>,
) {
  const queue = new Queue("notifications-critical", {
    connection: harness.redis,
    prefix: queuePrefix("notifications-critical"),
  });
  const database = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await database.connect();
  try {
    return await use({ queue, database });
  } finally {
    await queue.close();
    await database.end();
  }
}

/**
 * Takes the first queued notification to `address` from `template`, waiting for it:
 * better-auth sends some (one-time codes) in the background, after it has answered.
 */
export function takeNotification<T extends NotificationPayload["template"]>(
  harness: Harness,
  template: T,
  /** The email address or phone number it's sent to. */
  address: string,
): Promise<Notification<T>> {
  return withNotifications(harness, async (sources) => {
    try {
      return await eventually(
        () => findNotification(template, address, sources),
        (found): found is Notification<T> => found !== undefined,
        { timeout: 10_000 },
      );
    } catch (error) {
      throw new Error(`No ${template} queued for ${address}`, { cause: error });
    }
  });
}

/**
 * Takes the notification queued right now, if any, without waiting: for one that would
 * have been written before the request answered (security alerts, in its transaction).
 */
export function queuedNotification<T extends NotificationPayload["template"]>(
  harness: Harness,
  template: T,
  address: string,
) {
  return withNotifications(harness, (sources) => findNotification(template, address, sources));
}

/** Reads the one-time code queued for an email address. */
export async function takeOtp(harness: Harness, email: string) {
  const payload = await takeNotification(harness, "auth.otp", email);
  return { otp: payload.data.otp, locale: payload.to.locale, purpose: payload.data.purpose };
}

/** The Redis key holding a session (better-auth secondary storage, keyPrefix "auth:"). */
function sessionKey(session: { cookies(): Map<string, string> }) {
  const cookie = session.cookies().get("better-auth.session_token");
  if (!cookie) {
    throw new Error("not signed in");
  }
  return `auth:${decodeURIComponent(cookie).split(".")[0]}`;
}

/** Rewrites a stored session in place (to simulate time passing). */
export async function editSession(
  harness: Harness,
  session: { cookies(): Map<string, string> },
  edit: (stored: { createdAt: string; expiresAt: string }) => void,
) {
  const key = sessionKey(session);
  const stored = JSON.parse((await harness.redis.get(key)) ?? "null") as {
    session: { createdAt: string; expiresAt: string };
  } | null;
  if (!stored) {
    throw new Error(`no session at ${key}`);
  }
  edit(stored.session);
  await harness.redis.set(key, JSON.stringify(stored), "KEEPTTL");
}

/** Moves every pending one-time code for `email` past its expiry. */
export async function expireOtps(harness: Harness, email: string) {
  let expired = 0;
  for (const key of await harness.redis.keys("auth:verification:*")) {
    const raw = await harness.redis.get(key);
    if (!raw?.includes(email)) {
      continue;
    }
    const stored = JSON.parse(raw) as { expiresAt: string };
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await harness.redis.set(key, JSON.stringify(stored), "KEEPTTL");
    expired += 1;
  }
  if (!expired) {
    throw new Error(`no pending code for ${email}`);
  }
}

export const newEmail = () => `user-${randomUUID()}@test.dev`;
export const newPassword = () => `Pw-${randomUUID()}`;
