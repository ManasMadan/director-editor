/**
 * The webhooks service against a real (cloned) database: the mail server's (Stalwart's)
 * inbound delivery feedback, and the service starting on its port.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createRedis } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Two Stalwart keys, as during a rotation: the new one and the one it replaces.
const STALWART_KEY = randomBytes(32).toString("base64");
const STALWART_OLD_KEY = randomBytes(32).toString("base64");

let testDb: TestDatabase;
let app: NestFastifyApplication;
let baseUrl: string;

// ---------------------------------------------------------------------------- helpers

async function asRole<T>(role: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A port nothing listens on yet (for the service main.ts starts). */
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------- setup

beforeAll(async () => {
  testDb = await createTestDatabase();
  Object.assign(process.env, {
    WEBHOOKS_DATABASE_URL: testDb.urlFor("app_webhooks"),
    LOAD_SHEDDING: "off",
    REDIS_URL: redisDatabase(11),
    STALWART_WEBHOOK_SECRET: `${STALWART_KEY}, ${STALWART_OLD_KEY}`,
    PORT: String(await freePort()),
  });
  const redis = createRedis(process.env.REDIS_URL as string);
  await flushTestDatabase(redis);
  await redis.quit();
  const { createWebhooksServer } = await import("../src/server");
  app = await createWebhooksServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await testDb?.drop();
});

// ---------------------------------------------------------------------------- tests

describe("inbound Stalwart feedback", () => {
  /**
   * A Stalwart delivery event in the shape v0.16 sends, created now (the captured requests
   * are in src/inbound/stalwart-events.test.ts; their 64-bit spanId and queueId don't fit
   * a JavaScript number and aren't read).
   */
  const event = (type: string, to: string, details: string, at = new Date()) => ({
    id: `${Math.floor(at.getTime() / 1000)}${Math.floor(Math.random() * 1000)}87`,
    createdAt: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
    type,
    data: {
      to,
      hostname: "mx.example.com",
      details,
      total: 0,
      queueName: "remote",
      from: "no-reply@example.com",
      size: 306,
    },
  });
  const unknownUser = (to: string) =>
    event(
      "delivery.dsn-perm-fail",
      to,
      `Unexpected response for RCPT TO:<${to}>: Code: 550, Enhanced code: 5.1.1, Message: No such user`,
    );
  /** Posts a batch signed the way Stalwart signs it (X-Signature: base64 HMAC of the body). */
  async function post(
    events: unknown[],
    options: { key?: string; body?: string; signature?: string | null } = {},
  ) {
    const payload = JSON.stringify({ events });
    const signature = createHmac("sha256", options.key ?? STALWART_KEY)
      .update(payload)
      .digest("base64");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.signature !== null) {
      headers["x-signature"] = options.signature ?? signature;
    }
    const response = await fetch(`${baseUrl}/webhooks/stalwart`, {
      method: "POST",
      headers,
      body: options.body ?? payload,
    });
    return response.status;
  }
  /** email.feedback_received.v1 payloads emitted for these addresses. */
  const feedback = (...addresses: string[]) =>
    asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT payload FROM webhooks.outbox_event WHERE name = 'email.feedback_received.v1' AND payload->>'address' = ANY($1) ORDER BY id",
        [addresses],
      );
      return rows.map((row) => row.payload);
    });
  const stored = (address: string) =>
    asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT type FROM webhooks.inbound_event WHERE provider = 'stalwart' AND payload->'data'->>'to' = $1",
        [address],
      );
      return rows.map((row) => row.type);
    });
  const address = () => `${randomUUID()}@example.com`;

  it("turns a hard bounce into feedback, once however often Stalwart sends it", async () => {
    const [gone, alsoGone] = [address(), address()];
    const batch = [unknownUser(gone), unknownUser(alsoGone)];
    expect(await post(batch)).toBe(200);
    // A retried batch: the same events, which Stalwart numbers again.
    expect(await post(batch.map((item) => ({ ...item, id: `${item.id}9` })))).toBe(200);
    expect(await feedback(gone, alsoGone)).toEqual([
      { provider: "stalwart", kind: "bounce", address: gone },
      { provider: "stalwart", kind: "bounce", address: alsoGone },
    ]);
    expect(await stored(gone)).toEqual(["delivery.dsn-perm-fail"]);
  });

  it("acts once on an event that appears twice in one batch", async () => {
    const gone = address();
    const bounce = unknownUser(gone);
    expect(await post([bounce, bounce])).toBe(200);
    expect(await feedback(gone)).toHaveLength(1);
  });

  it("accepts a batch signed with the key being rotated out", async () => {
    const gone = address();
    expect(await post([unknownUser(gone)], { key: STALWART_OLD_KEY })).toBe(200);
    expect(await feedback(gone)).toHaveLength(1);
  });

  it("records but doesn't act on soft bounces, policy rejections and other events", async () => {
    const [busy, blocked, fine] = [address(), address(), address()];
    const batch = [
      event(
        "delivery.dsn-temp-fail",
        busy,
        "Connection failed: I/O error: Connection refused (os error 111)",
      ),
      event(
        "delivery.dsn-perm-fail",
        blocked,
        `Unexpected response for DATA: Code: 550, Enhanced code: 5.7.1, Message: Rejected as spam`,
      ),
      event("delivery.delivered", fine, "Ok"),
    ];
    expect(await post(batch)).toBe(200);
    expect(await feedback(busy, blocked, fine)).toEqual([]);
    expect(await stored(busy)).toEqual(["delivery.dsn-temp-fail"]);
    expect(await stored(blocked)).toEqual(["delivery.dsn-perm-fail"]);
    expect(await stored(fine)).toEqual(["delivery.delivered"]);
  });

  it("refuses another key, a changed body, a missing signature and a stale batch", async () => {
    const gone = address();
    const batch = [unknownUser(gone)];
    expect(await post(batch, { key: randomBytes(32).toString("base64") })).toBe(400);
    expect(await post(batch, { body: JSON.stringify({ events: [unknownUser(address())] }) })).toBe(
      400,
    );
    expect(await post(batch, { signature: null })).toBe(400);
    expect(await post(batch, { signature: "" })).toBe(400);
    const replay = [{ ...unknownUser(gone), createdAt: "2026-01-01T00:00:00Z" }];
    expect(await post(replay)).toBe(400);
    expect(await feedback(gone)).toEqual([]);
    expect(await stored(gone)).toEqual([]);
  });

  it("refuses signed bodies that aren't a batch of events", async () => {
    expect(await post([])).toBe(400);
    expect(await post([{ type: "delivery.dsn-perm-fail" }])).toBe(400);
    const notJson = "not json";
    const signature = createHmac("sha256", STALWART_KEY).update(notJson).digest("base64");
    expect(await post([], { body: notJson, signature })).toBe(400);
  });
});

describe("main", () => {
  it("starts the service on its port, answering health checks", async () => {
    const { app: service } = await import("../src/main");
    try {
      const live = await fetch(`http://127.0.0.1:${process.env.PORT}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await service.close();
    }
  });
});
