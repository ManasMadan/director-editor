/**
 * The webhooks service against a real (cloned) database, a private Redis database and a
 * local HTTP receiver: signed deliveries, retries, auto-disable, SSRF refusal, replay,
 * and Stripe's and Stalwart's inbound events.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { EventName } from "@repo/contracts/events";
import { type OrgId, orgIdSchema, webhookEndpointIdSchema } from "@repo/contracts/ids";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createProducer } from "@repo/jobs";
import { createRedis, keysFromEnv, SecretBox, webhookSecretContext } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import pg from "pg";
import { Webhook } from "standardwebhooks";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DeliveryService as Deliveries } from "../src/outbound/delivery.service";

const ENCRYPTION_KEYS = `test:${randomBytes(32).toString("base64")}`;
const STRIPE_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
// Two Stalwart keys, as during a rotation: the new one and the one it replaces.
const STALWART_KEY = randomBytes(32).toString("base64");
const STALWART_OLD_KEY = randomBytes(32).toString("base64");
const box = new SecretBox(keysFromEnv(ENCRYPTION_KEYS));

let testDb: TestDatabase;
let app: NestFastifyApplication;
let baseUrl: string;
let deliveries: Deliveries;

// ---------------------------------------------------------------------------- receiver

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
/** Status codes the receiver answers with, in order (then 200). */
let answers: number[] = [];
/** Runs while a request is in flight, before the receiver answers it. */
let whileSending: (() => Promise<unknown>) | undefined;

beforeEach(() => {
  received = [];
  answers = [];
  whileSending = undefined;
});

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

/** An organization with one endpoint, created the way apps/api does. */
async function endpoint(
  options: {
    url?: string;
    events?: string[];
    /** A secret replaced by a rotation, still signing until `expiresAt`. */
    previous?: { secret: string; expiresAt: Date };
  } = {},
) {
  const orgId = orgIdSchema.parse(randomUUID());
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const endpointId = webhookEndpointIdSchema.parse(randomUUID());
  const context = webhookSecretContext(endpointId);
  await asRole("app_api", async (client) => {
    await client.query(
      `INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)`,
      [orgId],
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO webhooks.endpoint
         (id, org_id, url, events, secret, previous_secret, previous_secret_expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        endpointId,
        orgId,
        options.url ?? receiverUrl,
        options.events ?? [],
        box.encrypt(secret, context),
        options.previous ? box.encrypt(options.previous.secret, context) : null,
        options.previous?.expiresAt ?? null,
      ],
    );
    await client.query("COMMIT");
  });
  return { orgId, endpointId, secret };
}

async function delivery(deliveryId: string) {
  return asRole("postgres", async (client) => {
    const { rows } = await client.query(
      "SELECT status, attempts, last_status, last_error FROM webhooks.delivery WHERE id = $1",
      [deliveryId],
    );
    return rows[0] as {
      status: string;
      attempts: number;
      last_status: number | null;
      last_error: string | null;
    };
  });
}

/** Publishes a domain event to the webhooks consumer queue, as the relay would. */
async function publish(orgId: OrgId | null, name: EventName = "todo.created.v1") {
  const producer = createProducer("events-webhooks", createRedis(process.env.REDIS_URL as string));
  const event = {
    id: randomUUID(),
    name,
    key: randomUUID(),
    payload: { todoId: randomUUID(), title: "Ship it" },
    orgId,
    actorId: null,
    requestId: null,
    occurredAt: new Date().toISOString(),
    source: "app",
  };
  await producer.add("event", event, { jobId: event.id });
  await producer.close();
  return event;
}

/** Waits until BullMQ has finished the job (the webhooks service processed it). */
async function processed(queue: "events-webhooks" | "webhook-deliveries", jobId: string) {
  const producer = createProducer(queue, createRedis(process.env.REDIS_URL as string));
  const done = await eventually(
    async () => (await producer.queue.getJob(jobId))?.isCompleted(),
    (completed) => completed === true,
  );
  await producer.close();
  return done;
}

/** Adds a webhook-deliveries job, as apps/api does. */
async function enqueue(
  name: "deliver" | "redeliver" | "send-test",
  payload: { deliveryId: string; orgId: string } | { endpointId: string; orgId: string },
  jobId: string = randomUUID(),
) {
  const producer = createProducer(
    "webhook-deliveries",
    createRedis(process.env.REDIS_URL as string),
  );
  await producer.add(name, payload as never, { jobId });
  await producer.close();
  return jobId;
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
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      received.push({ path: request.url ?? "", headers: request.headers, body });
      await whileSending?.();
      // An endpoint that moved: it points the sender somewhere else.
      if (request.url === "/moved") {
        response.writeHead(307, { location: "/hook" }).end();
        return;
      }
      response.statusCode = answers.shift() ?? 200;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  testDb = await createTestDatabase();
  Object.assign(process.env, {
    WEBHOOKS_DATABASE_URL: testDb.urlFor("app_webhooks"),
    LOAD_SHEDDING: "off",
    REDIS_URL: redisDatabase(11),
    ENCRYPTION_KEYS,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    STALWART_WEBHOOK_SECRET: `${STALWART_KEY}, ${STALWART_OLD_KEY}`,
    WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1",
    WEBHOOK_AUTO_DISABLE_HOURS: "1",
    PORT: String(await freePort()),
  });
  const redis = createRedis(process.env.REDIS_URL as string);
  await flushTestDatabase(redis);
  await redis.quit();
  const { createWebhooksServer } = await import("../src/server");
  const { DeliveryService } = await import("../src/outbound/delivery.service");
  app = await createWebhooksServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  deliveries = app.get(DeliveryService);
});

afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => receiver?.close(resolve));
  await testDb?.drop();
});

// ---------------------------------------------------------------------------- tests

describe("outbound deliveries", () => {
  it("delivers a subscribed event, signed so the reference library verifies it", async () => {
    const { orgId, secret } = await endpoint();
    const event = await publish(orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );

    const [request] = received;
    const verified = new Webhook(secret).verify(
      request?.body ?? "",
      request?.headers as Record<string, string>,
    );
    expect(verified).toMatchObject({ type: "todo.created.v1", data: { title: "Ship it" } });
    expect(request?.headers["webhook-id"]).toBe(event.id);
    expect(request?.headers["user-agent"]).toMatch(/Boilerplate-Webhooks/);
  });

  it("signs with the rotated-out secret too until its overlap ends", async () => {
    const previous = `whsec_${randomBytes(24).toString("base64")}`;
    const hour = 60 * 60 * 1000;
    const during = await endpoint({
      previous: { secret: previous, expiresAt: new Date(Date.now() + hour) },
    });
    const after = await endpoint({
      previous: { secret: previous, expiresAt: new Date(Date.now() - hour) },
    });

    await publish(during.orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    const [overlap] = received;
    const headers = overlap?.headers as Record<string, string>;
    // Receivers holding either secret accept it.
    const sent = JSON.parse(overlap?.body ?? "");
    expect(new Webhook(during.secret).verify(overlap?.body ?? "", headers)).toEqual(sent);
    expect(new Webhook(previous).verify(overlap?.body ?? "", headers)).toEqual(sent);

    await publish(after.orgId);
    await eventually(
      () => received.length,
      (n) => n === 2,
    );
    const expired = received[1];
    const expiredHeaders = expired?.headers as Record<string, string>;
    expect(expiredHeaders["webhook-signature"]?.split(" ")).toHaveLength(1);
    expect(new Webhook(after.secret).verify(expired?.body ?? "", expiredHeaders)).toEqual(
      JSON.parse(expired?.body ?? ""),
    );
    expect(() => new Webhook(previous).verify(expired?.body ?? "", expiredHeaders)).toThrow();
  });

  it("only sends subscribed events, and nothing for other organizations", async () => {
    const { orgId, endpointId } = await endpoint({ events: ["todo.deleted.v1"] });
    const created = await publish(orgId, "todo.created.v1");
    const elsewhere = await publish(orgIdSchema.parse(randomUUID()), "todo.deleted.v1");
    const deleted = await publish(orgId, "todo.deleted.v1");
    for (const event of [created, elsewhere, deleted]) {
      await processed("events-webhooks", event.id);
    }
    // Every event has been handled and made one delivery between them: nothing else is on
    // its way.
    const rows = await asRole("postgres", (client) =>
      client.query("SELECT count(*)::int AS n FROM webhooks.delivery WHERE endpoint_id = $1", [
        endpointId,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    expect(received.map((r) => (JSON.parse(r.body) as { type: string }).type)).toEqual([
      "todo.deleted.v1",
    ]);
    expect(received[0]?.headers["webhook-id"]).toBe(deleted.id);
  });

  it("the same event twice makes one delivery", async () => {
    const { orgId, endpointId } = await endpoint();
    const event = await publish(orgId);
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    const producer = createProducer(
      "events-webhooks",
      createRedis(process.env.REDIS_URL as string),
    );
    await producer.add("event", { ...event }, { jobId: `${event.id}-again` });
    await producer.close();
    await processed("events-webhooks", `${event.id}-again`);
    const rows = await asRole("postgres", (client) =>
      client.query("SELECT count(*)::int AS n FROM webhooks.delivery WHERE endpoint_id = $1", [
        endpointId,
      ]),
    );
    expect(rows.rows[0].n).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("records failures for retry, then marks the delivery failed on the last attempt", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    answers = [500, 503];
    expect(await deliveries.attempt(orgId, deliveryId, false)).toBe("retry");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_status: 500,
    });
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("failed");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "failed",
      attempts: 2,
      last_status: 503,
    });
  });

  it("records why an endpoint couldn't be reached as a code, never an internal message", async () => {
    // Nothing listens on port 9.
    const { orgId, endpointId } = await endpoint({ url: "http://127.0.0.1:9/hook" });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, false)).toBe("retry");
    expect(await delivery(deliveryId)).toMatchObject({
      last_status: null,
      last_error: "connection_failed",
    });
  });

  it("fails the job, not the endpoint, when signing fails on our side", async () => {
    const { orgId, endpointId } = await endpoint();
    // A secret encrypted under a key this service doesn't have (a botched rotation).
    await asRole("postgres", (client) =>
      client.query("UPDATE webhooks.endpoint SET secret = 'v1.missing-key.AAAA' WHERE id = $1", [
        endpointId,
      ]),
    );
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    await expect(deliveries.attempt(orgId, deliveryId, true)).rejects.toThrow();
    // The delivery waits for the job's retry; the endpoint is neither blamed nor turned off.
    expect(await delivery(deliveryId)).toMatchObject({
      status: "pending",
      attempts: 0,
      last_error: null,
    });
    const [row] = await asRole(
      "postgres",
      async (client) =>
        (
          await client.query("SELECT disabled_at FROM webhooks.endpoint WHERE id = $1", [
            endpointId,
          ])
        ).rows,
    );
    expect(row.disabled_at).toBeNull();
    expect(received).toEqual([]);
  });

  it("creates a test delivery once per send-test job, however often the job runs", async () => {
    const { orgId, endpointId } = await endpoint();
    const jobEventId = randomUUID();
    const first = await deliveries.createTest(orgId, endpointId, jobEventId);
    const retried = await deliveries.createTest(orgId, endpointId, jobEventId);
    expect(retried).toBe(first);
  });

  it("treats a redirect as a failed delivery, and never sends the signed body on", async () => {
    const { orgId, endpointId } = await endpoint({ url: receiverUrl.replace("/hook", "/moved") });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("failed");
    expect(await delivery(deliveryId)).toMatchObject({ status: "failed", last_status: 307 });
    expect(received.map((request) => request.path)).toEqual(["/moved"]);
  });

  it("disables an endpoint that has failed for longer than the limit, and says so", async () => {
    const { orgId, endpointId } = await endpoint();
    // A failure from two hours ago, and nothing has succeeded since.
    const old = await deliveries.createTest(orgId, endpointId);
    answers = [500];
    await deliveries.attempt(orgId, old, true);
    await asRole("postgres", (client) =>
      client.query(
        "UPDATE webhooks.delivery SET created_at = now() - interval '2 hours' WHERE id = $1",
        [old],
      ),
    );
    const latest = await deliveries.createTest(orgId, endpointId);
    answers = [500];
    await deliveries.attempt(orgId, latest, true);

    const state = await asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT disabled_reason FROM webhooks.endpoint WHERE id = $1",
        [endpointId],
      );
      const events = await client.query(
        "SELECT name FROM webhooks.outbox_event WHERE key = $1 AND name = 'webhook.endpoint_disabled.v1'",
        [endpointId],
      );
      return { reason: rows[0]?.disabled_reason, events: events.rowCount };
    });
    expect(state).toEqual({ reason: "failing", events: 1 });
  });

  it("never calls a private address that isn't explicitly allowed", async () => {
    const { orgId, endpointId } = await endpoint({ url: "http://10.0.0.1/hook" });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("failed");
    expect((await delivery(deliveryId)).last_error).toBe("destination_not_allowed");
  });

  it("replays a finished delivery with the same message id", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("succeeded");
    const producer = createProducer(
      "webhook-deliveries",
      createRedis(process.env.REDIS_URL as string),
    );
    await producer.add("redeliver", { deliveryId, orgId }, { jobId: randomUUID() });
    await producer.close();
    await eventually(
      () => received.length,
      (n) => n === 2,
    );
    expect(received[1]?.headers["webhook-id"]).toBe(received[0]?.headers["webhook-id"]);
    expect((await delivery(deliveryId)).status).toBe("succeeded");
  });

  it("skips a delivery asked for under another organization, or already finished", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    // Row-level security: from another organization the delivery isn't there.
    expect(await deliveries.attempt(orgIdSchema.parse(randomUUID()), deliveryId, true)).toBe(
      "skipped",
    );
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("succeeded");
    expect(await deliveries.attempt(orgId, deliveryId, true)).toBe("skipped");
    expect(received).toHaveLength(1);
  });

  it("fails a delivery to an endpoint disabled since, without calling it", async () => {
    const { orgId, endpointId } = await endpoint();
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    await asRole("postgres", (client) =>
      client.query(
        "UPDATE webhooks.endpoint SET disabled_at = now(), disabled_reason = 'failing' WHERE id = $1",
        [endpointId],
      ),
    );
    expect(await deliveries.attempt(orgId, deliveryId, false)).toBe("skipped");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error: "endpoint_disabled",
    });
    expect(received).toEqual([]);
  });

  it("doesn't sign with a previous secret whose overlap has no end", async () => {
    const previous = `whsec_${randomBytes(24).toString("base64")}`;
    const { orgId, endpointId, secret } = await endpoint({
      previous: { secret: previous, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    // A row edited by hand: the old secret kept, its end date gone.
    await asRole("postgres", (client) =>
      client.query("UPDATE webhooks.endpoint SET previous_secret_expires_at = NULL WHERE id = $1", [
        endpointId,
      ]),
    );
    await deliveries.attempt(orgId, await deliveries.createTest(orgId, endpointId), true);
    const headers = received[0]?.headers as Record<string, string>;
    expect(headers["webhook-signature"]?.split(" ")).toHaveLength(1);
    expect(new Webhook(secret).verify(received[0]?.body ?? "", headers)).toEqual(
      JSON.parse(received[0]?.body ?? ""),
    );
  });

  it("doesn't disable an endpoint that has succeeded since its failing delivery was made", async () => {
    const { orgId, endpointId } = await endpoint();
    // Made two hours ago and tried last; meanwhile a newer delivery went through.
    const stale = await deliveries.createTest(orgId, endpointId);
    await asRole("postgres", (client) =>
      client.query(
        "UPDATE webhooks.delivery SET created_at = now() - interval '2 hours' WHERE id = $1",
        [stale],
      ),
    );
    expect(
      await deliveries.attempt(orgId, await deliveries.createTest(orgId, endpointId), true),
    ).toBe("succeeded");
    answers = [500];
    expect(await deliveries.attempt(orgId, stale, true)).toBe("failed");
    const [row] = await asRole(
      "postgres",
      async (client) =>
        (
          await client.query("SELECT disabled_at FROM webhooks.endpoint WHERE id = $1", [
            endpointId,
          ])
        ).rows,
    );
    expect(row.disabled_at).toBeNull();
  });

  it("says nothing more when another attempt disabled the endpoint first", async () => {
    const { orgId, endpointId } = await endpoint();
    const old = await deliveries.createTest(orgId, endpointId);
    answers = [500];
    await deliveries.attempt(orgId, old, true);
    await asRole("postgres", (client) =>
      client.query(
        "UPDATE webhooks.delivery SET created_at = now() - interval '2 hours' WHERE id = $1",
        [old],
      ),
    );
    // Another replica's last attempt disables it while this one's request is in flight.
    answers = [500];
    whileSending = () =>
      asRole("postgres", (client) =>
        client.query(
          "UPDATE webhooks.endpoint SET disabled_at = now(), disabled_reason = 'failing' WHERE id = $1",
          [endpointId],
        ),
      );
    const latest = await deliveries.createTest(orgId, endpointId);
    expect(await deliveries.attempt(orgId, latest, true)).toBe("failed");
    const events = await asRole("postgres", (client) =>
      client.query(
        "SELECT id FROM webhooks.outbox_event WHERE key = $1 AND name = 'webhook.endpoint_disabled.v1'",
        [endpointId],
      ),
    );
    expect(events.rowCount).toBe(0);
  });

  it("sends nothing for an event that belongs to no organization", async () => {
    await endpoint();
    const event = await publish(null);
    expect(await processed("events-webhooks", event.id)).toBe(true);
    expect(received).toEqual([]);
  });

  it("retries a failed attempt through the queue, after the schedule's first delay", async () => {
    // Nothing listens on port 9.
    const { orgId, endpointId } = await endpoint({ url: "http://127.0.0.1:9/hook" });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    const jobId = await enqueue("deliver", { deliveryId, orgId });
    const producer = createProducer(
      "webhook-deliveries",
      createRedis(process.env.REDIS_URL as string),
    );
    // Waiting its retry: the attempt threw, so BullMQ scheduled the next one.
    const state = await eventually(
      async () => (await producer.queue.getJob(jobId))?.getState(),
      (current) => current === "delayed",
    );
    expect(state).toBe("delayed");
    expect(await delivery(deliveryId)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "connection_failed",
    });
    await producer.queue.remove(jobId);
    await producer.close();
  });

  it("replays nothing for a delivery that's still pending", async () => {
    const { orgId, endpointId } = await endpoint({ url: "http://127.0.0.1:9/hook" });
    const deliveryId = await deliveries.createTest(orgId, endpointId);
    expect(
      await processed("webhook-deliveries", await enqueue("redeliver", { deliveryId, orgId })),
    ).toBe(true);
    expect(await delivery(deliveryId)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("sends a test event from the settings page, named after its job", async () => {
    const { orgId, endpointId } = await endpoint();
    const jobId = await enqueue("send-test", { endpointId, orgId });
    await eventually(
      () => received.length,
      (n) => n === 1,
    );
    expect(received[0]?.headers["webhook-id"]).toBe(jobId);
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({ type: "webhook.test" });
    // A job id that isn't a UUID can't name the event: it gets a new one.
    await enqueue("send-test", { endpointId, orgId }, "settings-test-1");
    await eventually(
      () => received.length,
      (n) => n === 2,
    );
    expect(received[1]?.headers["webhook-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the service can't see endpoints without the organization set", async () => {
    await endpoint();
    const rows = await asRole("app_webhooks", (client) =>
      client.query("SELECT id FROM webhooks.endpoint"),
    );
    expect(rows.rowCount).toBe(0);
    await expect(
      asRole("app_webhooks", (client) => client.query("UPDATE webhooks.endpoint SET url = 'x'")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("inbound Stripe events", () => {
  const stripeEvent = () => ({
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_123", object: "subscription", status: "active" } },
  });
  const post = (body: string, signature: string) =>
    fetch(`${baseUrl}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

  it("accepts a correctly signed event once, however often Stripe sends it", async () => {
    const event = stripeEvent();
    const body = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_SECRET,
    });
    expect((await post(body, signature)).status).toBe(200);
    expect((await post(body, signature)).status).toBe(200);

    const rows = await asRole("postgres", async (client) => {
      const inbound = await client.query(
        "SELECT type FROM webhooks.inbound_event WHERE provider_event_id = $1",
        [event.id],
      );
      const outbox = await client.query(
        "SELECT payload FROM webhooks.outbox_event WHERE key = $1 AND name = 'stripe.event_received.v1'",
        [event.id],
      );
      return { inbound: inbound.rows, outbox: outbox.rows };
    });
    expect(rows.inbound).toEqual([{ type: "customer.subscription.updated" }]);
    expect(rows.outbox).toHaveLength(1);
    expect(rows.outbox[0].payload).toMatchObject({
      stripeEventId: event.id,
      object: { id: "sub_123" },
    });
  });

  it("rejects a bad signature or a changed body", async () => {
    const body = JSON.stringify(stripeEvent());
    const wrongSecret = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: `whsec_${randomBytes(24).toString("base64")}`,
    });
    expect((await post(body, wrongSecret)).status).toBe(400);
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_SECRET,
    });
    expect((await post(body.replace("active", "canceled"), signature)).status).toBe(400);
    expect((await post(body, "")).status).toBe(400);
  });
});

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
