/**
 * Integration test: a real queue (Valkey), the real processor and a real SMTP server
 * (Mailpit). Requires `bun run db:up`.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  apiKeyIdSchema,
  type OrgId,
  orgIdSchema,
  todoIdSchema,
  type UserId,
  userIdSchema,
  webhookEndpointIdSchema,
} from "@repo/contracts/ids";
import { createDb } from "@repo/db";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createProducer, type Producer, parseJob, queuePrefix } from "@repo/jobs";
import { createRedis, DATABASE, I18N, PinoLogger, REDIS } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEAD_APNS_TOKEN, type FakePush, FLAKY_APNS_TOKEN, startFakePush } from "./fake-push";
import { type FakeTwilio, startFakeTwilio, TWILIO_NUMBERS } from "./fake-twilio";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:58025";

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function waitForEmail(to: string): Promise<MailpitMessage> {
  return eventually(
    async () => {
      const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
      return ((await res.json()) as { messages: MailpitMessage[] }).messages[0];
    },
    (message): message is MailpitMessage => message !== undefined,
    { interval: 200 },
  );
}

/** A port nothing listens on yet. */
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("notifications service", () => {
  let app: INestApplicationContext;
  let testDb: TestDatabase;
  let producer: Producer<"notifications-critical">;
  let bulk: Producer<"notifications-bulk">;
  let push: FakePush;
  let twilio: FakeTwilio;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    push = await startFakePush();
    twilio = await startFakeTwilio();
    Object.assign(process.env, push.env, twilio.env);
    // The service connects as its own least-privileged role, exactly as in production.
    process.env.NOTIFICATIONS_DATABASE_URL = testDb.urlFor("app_notifications");
    // A private Redis database, so a notifications service running locally for
    // development can't take this test's jobs (the API tests use 13).
    process.env.REDIS_URL = redisDatabase(14);
    process.env.UNSUBSCRIBE_SECRET ??= "test-unsubscribe-secret-at-least-32-chars";
    // For the service main.ts starts, at the end.
    process.env.PORT = String(await freePort());
    process.env.LOAD_SHEDDING = "off";
    const redis = createRedis(process.env.REDIS_URL);
    await flushTestDatabase(redis);
    await redis.quit();
    // Imported after the env is set: env.ts validates at import time.
    const { AppModule } = await import("../src/app.module");
    const { env } = await import("../src/env");
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await app.init();
    producer = createProducer("notifications-critical", createRedis(env.REDIS_URL));
    bulk = createProducer("notifications-bulk", createRedis(env.REDIS_URL));
  });

  afterAll(async () => {
    await producer?.close();
    await bulk?.close();
    await app?.close();
    await push?.close();
    await twilio?.close();
    await testDb?.drop();
  });

  it("delivers a localized OTP email through the queue", async () => {
    const to = `otp-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "auth.otp",
        to: { email: to, locale: "es" },
        data: { otp: "314159", purpose: "email-verification", expiresInMinutes: 5 },
      },
      { jobId: randomUUID() },
    );

    const message = await waitForEmail(to);
    expect(message.Subject).toBe("Verifica tu correo");

    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    expect(full.Text).toContain("314159");
    expect(full.Text).toContain("Este código caduca en 5 minutos.");
    expect(full.HTML).toContain('lang="es"');
  });

  it("resolves a user recipient from the database and writes in their language", async () => {
    const email = `user-${randomUUID()}@test.dev`;
    // Users are created by the api service, which owns the auth schema.
    const api = createDb({ url: testDb.urlFor("app_api"), poolMax: 1, service: "test" });
    const user = await api.user
      .create({ data: { name: "Lucía", email, locale: "es" } })
      .then((row) => ({ ...row, id: userIdSchema.parse(row.id) }));
    await api.$disconnect();

    await bulk.add(
      "send",
      {
        template: "todo.reminder",
        to: { userId: user.id },
        data: { todoId: todoIdSchema.parse(randomUUID()), title: "Llamar al banco" },
      },
      { jobId: randomUUID() },
    );

    const message = await waitForEmail(email);
    expect(message.Subject).toBe("Recordatorio: Llamar al banco");
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain("Este es tu recordatorio para «Llamar al banco».");
  });

  it("deletes critical jobs as soon as they complete, so one-time codes never linger in Redis", async () => {
    const jobId = randomUUID();
    const to = `retention-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "auth.otp",
        to: { email: to, locale: "en" },
        data: { otp: "271828", purpose: "sign-in", expiresInMinutes: 5 },
      },
      { jobId },
    );
    await waitForEmail(to);
    // The worker acknowledges completion just after the SMTP send.
    await expect.poll(() => producer.queue.getJob(jobId)).toBeUndefined();
  });

  it("rejects payloads that break the contract before they reach the queue", async () => {
    await expect(
      producer.add(
        "send",
        {
          template: "auth.otp",
          to: { email: "not-an-email", locale: "es" },
          data: { otp: "1", purpose: "email-verification", expiresInMinutes: 5 },
        },
        { jobId: randomUUID() },
      ),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------------------ delivery policy

  /** A user created the way apps/api does, plus direct database access for assertions. */
  async function newUser(name = "Ada") {
    const email = `user-${randomUUID()}@test.dev`;
    const api = createDb({ url: testDb.urlFor("app_api"), poolMax: 1, service: "test" });
    const user = await api.user.create({ data: { name, email, locale: "en" } });
    await api.$disconnect();
    return { ...user, id: userIdSchema.parse(user.id) };
  }

  async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(query, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  async function reminder(userId: UserId, jobId = randomUUID()) {
    await bulk.add(
      "send",
      {
        template: "todo.reminder",
        to: { userId },
        data: { todoId: todoIdSchema.parse(randomUUID()), title: "Water the plants" },
      },
      { jobId },
    );
    return jobId;
  }

  function settle(jobId: string, deliveries: number) {
    return eventually(
      () =>
        sql<{ status: string }>(
          "SELECT status FROM notifications.delivery WHERE idempotency_key LIKE $1 AND status <> 'sending'",
          [`${jobId}:%`],
        ),
      (rows) => rows.length >= deliveries,
    );
  }

  it("puts a notification in the inbox and emails it with a one-click unsubscribe", async () => {
    const user = await newUser();
    const jobId = await reminder(user.id);
    await settle(jobId, 2);

    const inbox = await sql(
      "SELECT template, data, link FROM notifications.notification WHERE user_id = $1",
      [user.id],
    );
    expect(inbox).toEqual([
      {
        template: "todo.reminder",
        data: expect.objectContaining({ title: "Water the plants" }),
        link: "/dashboard",
      },
    ]);
    const message = await waitForEmail(user.email);
    const headers = (await (
      await fetch(`${MAILPIT}/api/v1/message/${message.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["List-Unsubscribe"]?.[0]).toMatch(
      /\/api\/v1\/notifications\/unsubscribe\?token=/,
    );
    expect(headers["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");
  });

  it("the same job twice delivers once on every channel", async () => {
    const user = await newUser();
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const payload = {
      template: "todo.reminder" as const,
      to: { userId: user.id },
      data: { todoId: todoIdSchema.parse(randomUUID()), title: "Only once" },
    };
    const key = randomUUID();
    // As when a job is retried or an event is redelivered.
    await dispatcher.dispatch(payload, key);
    await dispatcher.dispatch(payload, key);
    expect(
      await sql("SELECT id FROM notifications.notification WHERE user_id = $1", [user.id]),
    ).toHaveLength(1);
    await waitForEmail(user.email);
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`)
    ).json()) as { messages: unknown[] };
    expect(search.messages).toHaveLength(1);
  });

  it("respects a turned-off channel, and never turns off security email", async () => {
    const user = await newUser();
    await sql(
      "INSERT INTO notifications.preference (user_id, category, channel, enabled) VALUES ($1, 'activity', 'email', false), ($1, 'security', 'email', false)",
      [user.id],
    );
    const jobId = await reminder(user.id);
    const rows = await settle(jobId, 2);
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "skipped"]);

    await producer.add(
      "send",
      {
        template: "auth.security-alert",
        to: { email: user.email, locale: "en" },
        data: { event: "password-changed", securityUrl: "http://localhost:3000/settings/security" },
      },
      { jobId: randomUUID() },
    );
    expect((await waitForEmail(user.email)).Subject).toBe("Your password was changed");
  });

  it("never emails a suppressed address", async () => {
    const user = await newUser();
    await sql(
      "INSERT INTO notifications.suppression (channel, address, reason) VALUES ('email', $1, 'bounce')",
      [user.email.toLowerCase()],
    );
    const jobId = await reminder(user.id);
    const rows = await settle(jobId, 2);
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "suppressed"]);
  });

  it("stops emailing an address the provider reports bounced, whatever it says later", async () => {
    const user = await newUser();
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const queue = new Queue("events-notifications", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("events-notifications"),
    });
    /** Queues the event and waits until the service has handled it. */
    const feedback = async (kind: "bounce" | "complaint") => {
      const eventId = randomUUID();
      await events.add(
        "event",
        {
          id: eventId,
          name: "email.feedback_received.v1",
          key: `msg:${user.email}`,
          // In whatever case the mail server reported the address.
          payload: { provider: "stalwart", kind, address: user.email.toUpperCase() },
          orgId: null,
          actorId: null,
          requestId: null,
          occurredAt: new Date().toISOString(),
          source: "webhooks",
        },
        { jobId: eventId },
      );
      await expect.poll(() => queue.getJobState(eventId), { timeout: 10_000 }).toBe("completed");
    };
    const reasons = async () =>
      (
        await sql<{ reason: string }>(
          "SELECT reason FROM notifications.suppression WHERE channel = 'email' AND address = $1",
          [user.email.toLowerCase()],
        )
      ).map((row) => row.reason);

    await feedback("bounce");
    expect(await reasons()).toEqual(["bounce"]);
    // A later report doesn't change it: the first reason stands.
    await feedback("complaint");
    expect(await reasons()).toEqual(["bounce"]);
    await events.close();
    await queue.close();

    const rows = await settle(await reminder(user.id), 2);
    expect(rows.map((row) => row.status).sort()).toEqual(["sent", "suppressed"]);
  });

  it("holds non-urgent email for users on the daily digest", async () => {
    const user = await newUser();
    await sql("INSERT INTO notifications.settings (user_id, daily_digest) VALUES ($1, true)", [
      user.id,
    ]);
    const jobId = await reminder(user.id);
    await settle(jobId, 2);
    const digest = await sql(
      "SELECT template, data FROM notifications.digest_item WHERE user_id = $1",
      [user.id],
    );
    expect(digest).toEqual([
      { template: "todo.reminder", data: expect.objectContaining({ title: "Water the plants" }) },
    ]);
  });

  it("notifies a workspace's owners and admins when its webhook endpoint is disabled", async () => {
    const owner = await newUser("Owner");
    const admin = await newUser("Admin");
    const member = await newUser("Member");
    const orgId = orgIdSchema.parse(randomUUID());
    await sql("INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)", [
      orgId,
    ]);
    for (const [user, role] of [
      [owner, "owner"],
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3)", [
        orgId,
        user.id,
        role,
      ]);
    }
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const endpointId = webhookEndpointIdSchema.parse(randomUUID());
    const eventId = randomUUID();
    await events.add(
      "event",
      {
        id: eventId,
        name: "webhook.endpoint_disabled.v1",
        key: endpointId,
        payload: { endpointId, url: "https://example.com/hook", reason: "failing" },
        orgId,
        actorId: null,
        requestId: null,
        occurredAt: new Date().toISOString(),
        source: "webhooks",
      },
      { jobId: eventId },
    );
    await events.close();
    await settle(eventId, 4);
    const notified = await sql<{ user_id: string }>(
      "SELECT user_id FROM notifications.notification WHERE template = 'webhooks.endpoint-disabled' AND org_id = $1",
      [orgId],
    );
    expect(notified.map((row) => row.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect((await waitForEmail(admin.email)).Subject).toBe(
      "Webhook endpoint turned off: https://example.com/hook",
    );
  });

  it("tells a workspace's owners and admins when an API key or webhook endpoint is created", async () => {
    const [owner, admin, member] = [
      await newUser("Owner"),
      await newUser("Admin"),
      await newUser("Member"),
    ];
    const orgId = orgIdSchema.parse(randomUUID());
    await sql("INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)", [
      orgId,
    ]);
    for (const [user, role] of [
      [owner, "owner"],
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3)", [
        orgId,
        user.id,
        role,
      ]);
    }
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const created = [
      {
        name: "org.api_key_created.v1",
        payload: { apiKeyId: apiKeyIdSchema.parse(randomUUID()), name: "CI", scopes: [] },
      },
      {
        name: "webhook.endpoint_created.v1",
        payload: {
          endpointId: webhookEndpointIdSchema.parse(randomUUID()),
          url: "https://example.com/in",
        },
      },
    ];
    const ids: string[] = [];
    for (const { name, payload } of created) {
      const id = randomUUID();
      ids.push(id);
      await events.add(
        "event",
        {
          id,
          name,
          key: randomUUID(),
          payload,
          orgId,
          actorId: admin.id,
          requestId: null,
          occurredAt: new Date().toISOString(),
          source: "api",
        },
        { jobId: id },
      );
    }
    await events.close();
    for (const id of ids) {
      await settle(id, 2);
    }

    const subjects = async (email: string) => {
      const res = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      return ((await res.json()) as { messages: MailpitMessage[] }).messages
        .map((m) => m.Subject)
        .sort();
    };
    const expected = [
      "A webhook endpoint was added to your workspace",
      "An API key was created in your workspace",
    ];
    await waitForEmail(owner.email);
    expect(await subjects(owner.email)).toEqual(expected);
    expect(await subjects(admin.email)).toEqual(expected);
    expect(await subjects(member.email)).toEqual([]);
  });

  it("sends a notification asked for in the outbox, once however often it arrives", async () => {
    const email = `user-${randomUUID()}@test.dev`;
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const id = randomUUID();
    const event = {
      id,
      name: "notification.requested.v1",
      key: randomUUID(),
      payload: {
        notification: {
          template: "auth.security-alert",
          to: { email, locale: "en" },
          data: { event: "password-changed", securityUrl: "https://app.test/settings/security" },
        },
      },
      orgId: null,
      actorId: null,
      requestId: null,
      occurredAt: new Date().toISOString(),
      source: "app",
    };
    await events.add("event", event, { jobId: id });
    await events.add("event", event, { jobId: `${id}-again` });
    await events.close();
    await settle(id, 1);
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
    const sent = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications.delivery WHERE idempotency_key LIKE $1",
      [`${id}:%`],
    );
    expect(sent[0]?.n).toBe(1);
  });

  it("keeps each user's inbox private at the database level", async () => {
    const user = await newUser();
    await settle(await reminder(user.id), 2);
    const client = new pg.Client({ connectionString: testDb.urlFor("app_notifications") });
    await client.connect();
    const unscoped = await client.query("SELECT id FROM notifications.notification");
    await client.end();
    expect(unscoped.rowCount).toBe(0);
  });

  // ------------------------------------------------------------------------------ push

  /** A device registered from a session of the user's, as apps/api does. */
  async function addDevice(userId: string, platform: "ios" | "android" | "web", token: string) {
    const [session] = await sql<{ id: string }>(
      `INSERT INTO auth.session (token, user_id, expires_at, updated_at)
       VALUES ($1, $2, now() + interval '1 day', now()) RETURNING id`,
      [randomUUID(), userId],
    );
    await sql(
      "INSERT INTO notifications.device (user_id, session_id, platform, token) VALUES ($1, $2, $3, $4)",
      [userId, session?.id, platform, token],
    );
  }

  async function devices(userId: string) {
    return (
      await sql<{ token: string }>("SELECT token FROM notifications.device WHERE user_id = $1", [
        userId,
      ])
    ).map((row) => row.token);
  }

  async function pushStatuses(jobId: string) {
    const rows = await sql<{ status: string; error: string | null }>(
      "SELECT status, error FROM notifications.delivery WHERE idempotency_key LIKE $1 AND channel = 'push' ORDER BY idempotency_key",
      [`${jobId}:%`],
    );
    return rows;
  }

  function deliveredTo(token: string) {
    return push.delivered.filter((message) => message.token === token);
  }

  it("pushes to every device the user has, on Android, iOS and the web", async () => {
    const user = await newUser();
    const android = `android-${randomUUID()}`;
    const ios = randomUUID().replaceAll("-", "").repeat(2);
    const web = push.webSubscription();
    await addDevice(user.id, "android", android);
    await addDevice(user.id, "ios", ios);
    await addDevice(user.id, "web", web.token);

    const jobId = await reminder(user.id);
    // in-app, email and one push per device.
    const rows = await settle(jobId, 5);
    expect(rows.map((row) => row.status)).toEqual(Array(5).fill("sent"));

    for (const token of [android, ios, web.id]) {
      const [message] = deliveredTo(token);
      expect(message, token).toMatchObject({
        title: "Reminder",
        body: expect.stringContaining("Water the plants"),
        link: "/dashboard",
      });
    }
    // APNs groups by collapse id; Web Push replaces by topic and expires by TTL.
    expect(deliveredTo(ios)[0]?.headers["apns-collapse-id"]).toBe("todo.reminder");
    expect(deliveredTo(ios)[0]?.headers["apns-push-type"]).toBe("alert");
    expect(deliveredTo(web.id)[0]?.headers.topic).toBe("todoreminder");
    expect(deliveredTo(web.id)[0]?.headers.ttl).toBe(String(24 * 3600));
  });

  it("forgets devices whose tokens the providers report dead", async () => {
    const user = await newUser();
    const live = `android-${randomUUID()}`;
    await addDevice(user.id, "android", `dead-${randomUUID()}`);
    await addDevice(user.id, "android", `malformed-${randomUUID()}`);
    await addDevice(user.id, "android", live);
    await addDevice(user.id, "ios", DEAD_APNS_TOKEN);
    await addDevice(user.id, "web", push.goneSubscription());

    const jobId = await reminder(user.id);
    await settle(jobId, 7);
    const statuses = (await pushStatuses(jobId)).map((row) => row.status).sort();
    expect(statuses).toEqual(["sent", "skipped", "skipped", "skipped", "skipped"]);
    expect(await devices(user.id)).toEqual([live]);
    expect(deliveredTo(live)).toHaveLength(1);
  });

  it("never sends to a stored subscription outside the browsers' push services", async () => {
    const user = await newUser();
    // As if a row got in without the api's validation: an internal address.
    const internal = push.webSubscription("http://169.254.169.254/latest/meta-data").token;
    await addDevice(user.id, "web", internal);
    const jobId = await reminder(user.id);
    await settle(jobId, 3);
    expect(await pushStatuses(jobId)).toEqual([
      { status: "skipped", error: expect.stringContaining("not a browser push service") },
    ]);
    expect(await devices(user.id)).toEqual([]);
  });

  it("keeps going when a push provider throws: other devices and channels still get it", async () => {
    const user = await newUser();
    const live = `android-${randomUUID()}`;
    await addDevice(user.id, "android", `crash-${randomUUID()}`);
    await addDevice(user.id, "android", live);
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const key = randomUUID();
    await expect(
      dispatcher.dispatch(
        {
          template: "todo.reminder",
          to: { userId: user.id },
          data: { todoId: todoIdSchema.parse(randomUUID()), title: "Still" },
        },
        key,
      ),
    ).rejects.toThrow(/1 deliveries failed/);
    expect((await pushStatuses(key)).map((row) => row.status).sort()).toEqual(["failed", "sent"]);
    expect(deliveredTo(live)).toHaveLength(1);
    expect((await waitForEmail(user.email)).Subject).toBe("Reminder: Still");
  });

  it("retries a push the provider failed, without resending the ones that went out", async () => {
    const user = await newUser();
    const good = `android-${randomUUID()}`;
    const flaky = `flaky-${randomUUID()}`;
    await addDevice(user.id, "android", good);
    await addDevice(user.id, "android", flaky);
    await addDevice(user.id, "ios", FLAKY_APNS_TOKEN);
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const payload = {
      template: "todo.reminder" as const,
      to: { userId: user.id },
      data: { todoId: todoIdSchema.parse(randomUUID()), title: "Try again" },
    };
    const key = randomUUID();

    await expect(dispatcher.dispatch(payload, key)).rejects.toThrow(/2 deliveries failed/);
    expect((await pushStatuses(key)).map((row) => row.status).sort()).toEqual([
      "failed",
      "failed",
      "sent",
    ]);
    // A transient failure keeps the device.
    expect(await devices(user.id)).toHaveLength(3);

    push.recover();
    await dispatcher.dispatch(payload, key);
    expect((await pushStatuses(key)).map((row) => row.status)).toEqual(["sent", "sent", "sent"]);
    expect(deliveredTo(good)).toHaveLength(1);
    expect(deliveredTo(flaky)).toHaveLength(1);
  });

  it("respects push turned off for a category", async () => {
    const user = await newUser();
    const token = `android-${randomUUID()}`;
    await addDevice(user.id, "android", token);
    await sql(
      "INSERT INTO notifications.preference (user_id, category, channel, enabled) VALUES ($1, 'activity', 'push', false)",
      [user.id],
    );
    const jobId = await reminder(user.id);
    await settle(jobId, 2);
    // Every channel is tried within the job: once it's done, no push is on its way.
    expect(await finished(bulk.queue, jobId)).toBe("completed");
    expect(await pushStatuses(jobId)).toEqual([]);
    expect(deliveredTo(token)).toEqual([]);
  });

  it("holds push during quiet hours and sends it once they end", async () => {
    const user = await newUser();
    const token = `android-${randomUUID()}`;
    await addDevice(user.id, "android", token);
    // Quiet from an hour ago to an hour from now, in the user's time zone (UTC).
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    await sql(
      "INSERT INTO notifications.settings (user_id, quiet_start, quiet_end) VALUES ($1, $2, $3)",
      [user.id, (minute - 60 + 1440) % 1440, (minute + 60) % 1440],
    );
    const jobId = await reminder(user.id);
    // In-app and email don't wait.
    await settle(jobId, 2);
    expect(await pushStatuses(jobId)).toEqual([]);

    const deferredFor = (job: { name: string; data: unknown }) =>
      job.name === "deferred" &&
      parseJob("notifications-bulk", "deferred", job.data).payload.userId === user.id;
    const delayed = (await bulk.queue.getDelayed()).filter(deferredFor);
    expect(delayed).toHaveLength(1);
    const [job] = delayed;
    const wait = (job?.opts.delay ?? 0) / 60_000;
    expect(wait).toBeGreaterThan(58);
    expect(wait).toBeLessThanOrEqual(60);

    // A redelivered job doesn't queue the push twice.
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const redelivered = await bulk.queue.getJob(jobId);
    await dispatcher.dispatch(
      parseJob("notifications-bulk", "send", redelivered?.data).payload,
      jobId,
    );
    expect((await bulk.queue.getDelayed()).filter(deferredFor)).toHaveLength(1);

    // Quiet hours are over.
    await job?.promote();
    await expect.poll(() => deliveredTo(token), { timeout: 15_000 }).toHaveLength(1);
    expect((await pushStatuses(jobId)).map((row) => row.status)).toEqual(["sent"]);
  });
  // ------------------------------------------------------------------------------- sms

  async function smsStatuses(jobId: string) {
    return sql<{ status: string; error: string | null }>(
      "SELECT status, error FROM notifications.delivery WHERE idempotency_key LIKE $1 AND channel = 'sms'",
      [`${jobId}:%`],
    );
  }

  async function textCode(phone: string, locale: "en" | "es" = "en", jobId = randomUUID()) {
    await producer.add(
      "send",
      {
        template: "auth.phone-code",
        to: { phone, locale },
        data: { code: "482913", expiresInMinutes: 10 },
      },
      { jobId },
    );
    return jobId;
  }

  function settleSms(jobId: string) {
    return eventually(
      async () => (await smsStatuses(jobId)).filter((row) => row.status !== "sending"),
      (rows) => rows.length > 0,
    );
  }

  const newPhone = () => `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

  it("texts a verification code in the recipient's language, through Twilio", async () => {
    const phone = newPhone();
    const jobId = await textCode(phone, "es");
    expect(await settleSms(jobId)).toEqual([{ status: "sent", error: null }]);
    expect(twilio.to(phone)).toEqual([
      {
        to: phone,
        from: "+15005550006",
        body: "482913 es tu código de verificación de Boilerplate. Caduca en 10 minutos. No lo compartas con nadie.",
      },
    ]);
    const [row] = await sql<{ provider_message_id: string }>(
      "SELECT provider_message_id FROM notifications.delivery WHERE idempotency_key LIKE $1",
      [`${jobId}:%`],
    );
    expect(row?.provider_message_id).toMatch(/^SM[0-9a-f]{32}$/);
  });

  it("texts security alerts to the account's phone as well as emailing them", async () => {
    const phone = newPhone();
    const email = `alert-${randomUUID()}@test.dev`;
    const jobId = randomUUID();
    await producer.add(
      "send",
      {
        template: "auth.security-alert",
        to: { email, locale: "en", phone },
        data: { event: "password-changed", securityUrl: "http://localhost:3000/settings/security" },
      },
      { jobId },
    );
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
    await settleSms(jobId);
    expect(twilio.to(phone).map((message) => message.body)).toEqual([
      "Boilerplate: your password was changed. Not you? Reset your password now.",
    ]);
  });

  it("stops texting a number that replied STOP, or can't receive texts", async () => {
    for (const [phone, reason] of [
      [TWILIO_NUMBERS.optedOut, "unsubscribe"],
      [TWILIO_NUMBERS.invalid, "invalid"],
      [TWILIO_NUMBERS.landline, "invalid"],
    ] as const) {
      const first = await textCode(phone);
      expect((await settleSms(first))[0]?.status, phone).toBe("suppressed");
      expect(
        await sql(
          "SELECT reason FROM notifications.suppression WHERE channel = 'sms' AND address = $1",
          [phone],
        ),
      ).toEqual([{ reason }]);
      // The next text isn't even attempted.
      const second = await textCode(phone);
      expect(await settleSms(second)).toEqual([{ status: "suppressed", error: null }]);
    }
  });

  it("records a permanent failure without retrying, and retries a transient one", async () => {
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const payload = (phone: string) => ({
      template: "auth.phone-code" as const,
      to: { phone, locale: "en" as const },
      data: { code: "111222", expiresInMinutes: 10 },
    });

    // Region not enabled: a configuration problem, not the number's fault. No retry,
    // no suppression.
    const blocked = randomUUID();
    await dispatcher.dispatch(payload(TWILIO_NUMBERS.regionBlocked), blocked);
    expect(await smsStatuses(blocked)).toEqual([
      { status: "failed", error: expect.stringContaining("21408") },
    ]);
    expect(
      await sql("SELECT 1 FROM notifications.suppression WHERE address = $1", [
        TWILIO_NUMBERS.regionBlocked,
      ]),
    ).toEqual([]);

    const flaky = randomUUID();
    await expect(dispatcher.dispatch(payload(TWILIO_NUMBERS.flaky), flaky)).rejects.toThrow(
      /1 deliveries failed/,
    );
    twilio.recover();
    await dispatcher.dispatch(payload(TWILIO_NUMBERS.flaky), flaky);
    expect((await smsStatuses(flaky)).map((row) => row.status)).toEqual(["sent"]);
    expect(twilio.to(TWILIO_NUMBERS.flaky)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------- digest

  /** A time zone where it's past the digest hour now, and one where it isn't yet. */
  async function digestZones() {
    const { wallClock: localClock } = await import("../src/wall-clock");
    const zones = [
      "Pacific/Pago_Pago",
      "Pacific/Honolulu",
      "America/Los_Angeles",
      "America/New_York",
      "UTC",
      "Europe/Berlin",
      "Asia/Kolkata",
      "Asia/Tokyo",
      "Pacific/Kiritimati",
    ];
    const due = zones.find((zone) => localClock(zone).hour >= 8);
    const early = zones.find((zone) => localClock(zone).hour < 8);
    if (!due || !early) {
      throw new Error("no suitable time zones right now");
    }
    return { due, early, dateIn: (zone: string) => localClock(zone).date };
  }

  async function digestUser(timezone: string) {
    const user = await newUser();
    await sql(`UPDATE auth."user" SET timezone = $2 WHERE id = $1`, [user.id, timezone]);
    await sql("INSERT INTO notifications.settings (user_id, daily_digest) VALUES ($1, true)", [
      user.id,
    ]);
    return user;
  }

  async function digests() {
    const { DigestService } = await import("../src/digest/digest.service");
    return app.get(DigestService);
  }

  it("sends one digest a day with everything that waited, once it's digest time locally", async () => {
    const { due, dateIn } = await digestZones();
    const user = await digestUser(due);
    for (const title of ["Water the plants", "Call the bank"]) {
      await settle(
        await bulk
          .add(
            "send",
            {
              template: "todo.reminder",
              to: { userId: user.id },
              data: { todoId: todoIdSchema.parse(randomUUID()), title },
            },
            { jobId: randomUUID() },
          )
          .then((job) => job.id as string),
        2,
      );
    }
    expect(
      await sql("SELECT 1 FROM notifications.digest_item WHERE user_id = $1", [user.id]),
    ).toHaveLength(2);

    expect(await (await digests()).scheduleDue()).toBeGreaterThanOrEqual(1);
    const email = await waitForEmail(user.email);
    expect(email.Subject).toBe("Your daily summary");
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${email.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain("2 updates since your last summary");
    expect(full.Text).toContain("Water the plants");
    expect(full.Text).toContain("Call the bank");
    expect(full.Text.indexOf("Water the plants")).toBeLessThan(full.Text.indexOf("Call the bank"));

    // Sent items are gone; the day's digest is recorded.
    await expect
      .poll(() => sql("SELECT 1 FROM notifications.digest_item WHERE user_id = $1", [user.id]))
      .toEqual([]);
    expect(
      await sql("SELECT status FROM notifications.delivery WHERE idempotency_key = $1", [
        `digest:${user.id}:${dateIn(due)}`,
      ]),
    ).toEqual([{ status: "sent" }]);

    // Something new later the same day waits for tomorrow's digest.
    await sql(
      `INSERT INTO notifications.digest_item (user_id, template, data) VALUES ($1, 'todo.reminder', '{"title": "Later"}')`,
      [user.id],
    );
    await (await digests()).send(user.id, dateIn(due));
    await (await digests()).scheduleDue();
    // The day's digest job is the one already done (the same id is never queued twice).
    expect(await finished(bulk.queue, `digest-${user.id}-${dateIn(due)}`)).toBe("completed");
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`)
    ).json()) as { messages: unknown[] };
    expect(search.messages).toHaveLength(1);
    expect(
      await sql("SELECT 1 FROM notifications.digest_item WHERE user_id = $1", [user.id]),
    ).toHaveLength(1);
  });

  it("waits for the digest hour in the user's own time zone", async () => {
    const { early, dateIn } = await digestZones();
    const user = await digestUser(early);
    await sql(
      `INSERT INTO notifications.digest_item (user_id, template, data) VALUES ($1, 'todo.reminder', '{"title": "Not yet"}')`,
      [user.id],
    );
    await (await digests()).scheduleDue();
    expect(await bulk.queue.getJob(`digest-${user.id}-${dateIn(early)}`)).toBeUndefined();
  });

  it("drops a suppressed address's digest instead of keeping it forever", async () => {
    const { due, dateIn } = await digestZones();
    const user = await digestUser(due);
    await sql(
      "INSERT INTO notifications.suppression (channel, address, reason) VALUES ('email', $1, 'bounce')",
      [user.email.toLowerCase()],
    );
    await sql(
      `INSERT INTO notifications.digest_item (user_id, template, data) VALUES ($1, 'todo.reminder', '{"title": "Bounced"}')`,
      [user.id],
    );
    await (await digests()).send(user.id, dateIn(due));
    expect(
      await sql("SELECT 1 FROM notifications.digest_item WHERE user_id = $1", [user.id]),
    ).toEqual([]);
    expect(
      await sql("SELECT status FROM notifications.delivery WHERE idempotency_key = $1", [
        `digest:${user.id}:${dateIn(due)}`,
      ]),
    ).toEqual([{ status: "suppressed" }]);
  });

  it("registers the hourly digest run once", async () => {
    const schedulers = await bulk.queue.getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key)).toEqual(["digests"]);
    expect(schedulers[0]?.pattern).toBe("5 * * * *");
  });

  it("only the owner-scoped function sees who has items waiting", async () => {
    const client = new pg.Client({ connectionString: testDb.urlFor("app_api") });
    await client.connect();
    await expect(client.query("SELECT notifications.users_with_digest_items()")).rejects.toThrow(
      /permission denied/,
    );
    await client.end();
  });

  // --------------------------------------------------------------------------- billing

  it("tells a workspace's owners and admins, in their language, when a payment fails", async () => {
    const owner = await newUser("Owner");
    const admin = await newUser("Admin");
    const member = await newUser("Member");
    await sql(`UPDATE auth."user" SET locale = 'es' WHERE id = $1`, [admin.id]);
    const orgId = orgIdSchema.parse(randomUUID());
    await sql(
      "INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Acme', $1::text)",
      [orgId],
    );
    for (const [user, role] of [
      [owner, "owner"],
      [admin, "admin"],
      [member, "member"],
    ] as const) {
      await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3)", [
        orgId,
        user.id,
        role,
      ]);
    }
    const jobId = randomUUID();
    await producer.add(
      "send",
      {
        template: "billing.payment-failed",
        to: { orgId, roles: ["owner", "admin"] },
        data: {
          organizationName: "Acme",
          amount: 3_600,
          currency: "USD",
          billingUrl: "http://localhost:3000/settings/billing",
        },
      },
      { jobId },
    );
    await settle(jobId, 4);
    const inbox = await sql<{ user_id: string; data: { amount: string }; link: string }>(
      "SELECT user_id, data, link FROM notifications.notification WHERE template = 'billing.payment-failed' AND org_id = $1",
      [orgId],
    );
    expect(inbox.map((row) => row.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(inbox.find((row) => row.user_id === owner.id)?.data.amount).toBe("$36.00");
    expect(inbox.find((row) => row.user_id === admin.id)?.data.amount).toBe("36,00\u00a0US$");
    expect(inbox[0]?.link).toBe("/settings/billing");

    const english = await waitForEmail(owner.email);
    expect(english.Subject).toBe("Payment failed for Acme");
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${english.ID}`)).json()) as {
      Text: string;
    };
    expect(full.Text).toContain("The renewal payment of $36.00 for Acme didn't go through.");
    expect((await waitForEmail(admin.email)).Subject).toBe("Falló el pago de Acme");
    // Not the plain member, and payment emails can't be turned off.
    const search = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${member.email}`)}`)
    ).json()) as { messages: unknown[] };
    expect(search.messages).toHaveLength(0);
  });

  // ------------------------------------------------------------------ the rarer paths

  async function dispatcher() {
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    return app.get(Dispatcher);
  }

  /** An organization with these members, created the way apps/api does. */
  async function workspace(members: [{ id: string }, string][]) {
    const orgId = orgIdSchema.parse(randomUUID());
    await sql("INSERT INTO auth.organization (id, name, slug) VALUES ($1::uuid, 'Org', $1::text)", [
      orgId,
    ]);
    for (const [user, role] of members) {
      await sql("INSERT INTO auth.member (organization_id, user_id, role) VALUES ($1, $2, $3)", [
        orgId,
        user.id,
        role,
      ]);
    }
    return orgId;
  }

  /** Waits until BullMQ has finished the job, one way or the other. */
  function finished(queue: Queue, jobId: string) {
    return eventually(
      async () => (await queue.getJob(jobId))?.getState(),
      (state) => state === "completed" || state === "failed",
    );
  }

  async function mailText(email: string) {
    const message = await waitForEmail(email);
    return (
      (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as { Text: string }
    ).Text;
  }

  it("sends nothing to a user deleted before the notification went out", async () => {
    const key = randomUUID();
    await (await dispatcher()).dispatch(
      {
        template: "todo.reminder",
        to: { userId: userIdSchema.parse(randomUUID()) },
        data: { todoId: todoIdSchema.parse(randomUUID()), title: "Nobody" },
      },
      key,
    );
    expect(
      await sql("SELECT 1 FROM notifications.delivery WHERE idempotency_key LIKE $1", [`${key}:%`]),
    ).toEqual([]);
  });

  it("writes in English to a user whose language it doesn't speak, and greets the nameless", async () => {
    const user = await newUser(" ");
    await sql(`UPDATE auth."user" SET locale = 'fr' WHERE id = $1`, [user.id]);
    await settle(await reminder(user.id), 2);
    const text = await mailText(user.email);
    // The greeting without a name (the plain-text version writes headings in capitals).
    expect(text).toMatch(/^hi,\r?$/im);
    expect(text).toContain("This is your reminder for");
  });

  it("emails an invitation in the invitee's language", async () => {
    const to = `invitee-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "org.invitation",
        to: { email: to, locale: "en" },
        data: {
          organizationName: "Acme",
          inviterName: "Ada",
          acceptUrl: "http://localhost:3000/invitations/abc",
          expiresInDays: 7,
        },
      },
      { jobId: randomUUID() },
    );
    expect((await waitForEmail(to)).Subject).toBe("You're invited to a workspace on Boilerplate");
    expect(await mailText(to)).toContain(
      "“Ada” invited you to collaborate in the workspace “Acme”.",
    );
  });

  it("still reaches the next admin when a push can't be recorded for the first", async () => {
    const [owner, admin] = [await newUser("Owner"), await newUser("Admin")];
    const tokens = [`android-${randomUUID()}`, `android-${randomUUID()}`];
    await addDevice(owner.id, "android", tokens[0] as string);
    await addDevice(admin.id, "android", tokens[1] as string);
    const orgId = await workspace([
      [owner, "owner"],
      [admin, "admin"],
    ]);
    const key = randomUUID();
    // While the first push is in flight its delivery row disappears, so recording the
    // result throws.
    push.hooks.whileDelivering = async () => {
      push.hooks.whileDelivering = undefined;
      await sql("DELETE FROM notifications.delivery WHERE idempotency_key LIKE $1", [
        `${key}:push:%`,
      ]);
    };
    const endpointId = webhookEndpointIdSchema.parse(randomUUID());
    await expect(
      (await dispatcher()).dispatch(
        {
          template: "webhooks.endpoint-disabled",
          to: { orgId, roles: ["owner", "admin"] },
          data: { endpointId, url: "https://example.com/hook" },
        },
        key,
      ),
    ).rejects.toThrow(/1 deliveries failed/);
    for (const token of tokens) {
      expect(deliveredTo(token), token).toEqual([
        expect.objectContaining({
          title: "A webhook endpoint was turned off",
          link: `/settings/webhooks/${endpointId}`,
        }),
      ]);
    }
    expect(await pushStatuses(key)).toEqual([{ status: "sent", error: null }]);
  });

  it("drops a deferred push for a user deleted meanwhile, and retries one that fails", async () => {
    const payload = (userId: UserId) => ({
      template: "todo.reminder" as const,
      to: { userId },
      data: { todoId: todoIdSchema.parse(randomUUID()), title: "Later" },
    });
    const gone = userIdSchema.parse(randomUUID());
    await (await dispatcher()).deliverDeferred(payload(gone), "push", gone, randomUUID());

    const user = await newUser();
    await addDevice(user.id, "android", `crash-${randomUUID()}`);
    const key = randomUUID();
    await expect(
      (await dispatcher()).deliverDeferred(payload(user.id), "push", user.id, key),
    ).rejects.toThrow(/deferred delivery failed/);
    expect((await pushStatuses(key)).map((row) => row.status)).toEqual(["failed"]);
  });

  it("skips texts when no SMS provider is configured, and still emails", async () => {
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const { RecipientResolver } = await import("../src/dispatch/recipients");
    const { TemplateSource } = await import("../src/dispatch/templates");
    const { DeliveryLog } = await import("../src/dispatch/delivery-log");
    const { DeliveryPolicy } = await import("../src/dispatch/policy");
    const { EmailChannel } = await import("../src/channels/email/email.channel");
    const { InAppChannel } = await import("../src/channels/in-app/in-app.channel");
    const { PushChannel } = await import("../src/channels/push/push.channel");
    const { SmsChannel } = await import("../src/channels/sms/sms.channel");
    const logger = new PinoLogger({});
    // The dispatcher as production builds it with SMS_PROVIDER unset.
    const withoutSms = new Dispatcher(
      app.get(I18N),
      app.get(RecipientResolver),
      app.get(TemplateSource),
      app.get(DeliveryLog),
      app.get(DeliveryPolicy),
      app.get(EmailChannel),
      app.get(InAppChannel),
      app.get(PushChannel),
      new SmsChannel(null, logger),
      app.get(REDIS),
      app.get(DATABASE),
      logger,
    );
    const email = `no-sms-${randomUUID()}@test.dev`;
    const key = randomUUID();
    await withoutSms.dispatch(
      {
        template: "auth.security-alert",
        to: { email, locale: "en", phone: newPhone() },
        data: { event: "password-changed", securityUrl: "http://localhost:3000/settings/security" },
      },
      key,
    );
    expect(await smsStatuses(key)).toEqual([
      { status: "skipped", error: "no SMS provider configured" },
    ]);
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
  });

  it("fails a job neither queue knows, and runs the hourly digest job", async () => {
    const mystery = randomUUID();
    await bulk.queue.add("mystery", { meta: {}, payload: {} }, { jobId: mystery, attempts: 1 });
    expect(await finished(bulk.queue, mystery)).toBe("failed");
    expect((await bulk.queue.getJob(mystery))?.failedReason).toBe(
      'Unknown job "mystery" on notifications-bulk',
    );
    const hourly = randomUUID();
    await bulk.queue.add("digests", { meta: {}, payload: {} }, { jobId: hourly });
    expect(await finished(bulk.queue, hourly)).toBe("completed");
  });

  it("ignores events that notify nobody", async () => {
    const events = createProducer(
      "events-notifications",
      createRedis(process.env.REDIS_URL as string),
    );
    const event = (name: string, payload: unknown, orgId: OrgId | null) => ({
      id: randomUUID(),
      name,
      key: randomUUID(),
      payload,
      orgId,
      actorId: null,
      requestId: null,
      occurredAt: new Date().toISOString(),
      source: "api",
    });
    const quiet = [
      // Not an event this service maps to anything.
      event(
        "todo.created.v1",
        { todoId: todoIdSchema.parse(randomUUID()), title: "t" },
        orgIdSchema.parse(randomUUID()),
      ),
      // Workspace events without a workspace have nobody to tell.
      event(
        "webhook.endpoint_disabled.v1",
        {
          endpointId: webhookEndpointIdSchema.parse(randomUUID()),
          url: "https://example.com",
          reason: "failing",
        },
        null,
      ),
      event(
        "org.api_key_created.v1",
        { apiKeyId: apiKeyIdSchema.parse(randomUUID()), name: "CI", scopes: [] },
        null,
      ),
    ];
    for (const item of quiet) {
      await events.add("event", item, { jobId: item.id });
    }
    for (const item of quiet) {
      expect(await finished(events.queue, item.id)).toBe("completed");
    }
    await events.close();
    for (const item of quiet) {
      expect(
        await sql("SELECT 1 FROM notifications.delivery WHERE idempotency_key LIKE $1", [
          `${item.id}:%`,
        ]),
      ).toEqual([]);
    }
  });

  it("skips a digest with nothing in it, or for a user who's gone", async () => {
    const user = await digestUser("UTC");
    const date = new Date().toISOString().slice(0, 10);
    const gone = userIdSchema.parse(randomUUID());
    for (const userId of [user.id, gone]) {
      await (await digests()).send(userId, date);
    }
    expect(
      await sql(
        "SELECT status, error FROM notifications.delivery WHERE idempotency_key = ANY($1) ORDER BY idempotency_key",
        [[`digest:${user.id}:${date}`, `digest:${gone}:${date}`]],
      ),
    ).toEqual([
      { status: "skipped", error: "nothing to send" },
      { status: "skipped", error: "nothing to send" },
    ]);
  });

  it("starts as a service on its port, answering health checks", async () => {
    const { app: service } = await import("../src/main");
    try {
      const live = await fetch(`http://127.0.0.1:${process.env.PORT}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await service.close();
    }
  });
});
