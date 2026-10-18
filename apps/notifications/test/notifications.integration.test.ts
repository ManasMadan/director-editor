/**
 * Integration test: a real queue (Valkey), the real processors and a real SMTP server
 * (Mailpit). Requires `bun run db:up`.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createProducer, type Producer, queuePrefix } from "@repo/jobs";
import { createRedis } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import { Queue } from "bullmq";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:58025";

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function emailsTo(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

async function waitForEmail(to: string): Promise<MailpitMessage> {
  return eventually(
    async () => (await emailsTo(to))[0],
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

const securityAlert = (email: string) => ({
  template: "auth.security-alert" as const,
  to: { email, locale: "en" as const },
  data: {
    event: "password-changed" as const,
    securityUrl: "http://localhost:3000/settings/security",
  },
});

/** A domain event, as the outbox relay queues it. */
const eventOf = (name: string, payload: unknown) => ({
  id: randomUUID(),
  name,
  key: randomUUID(),
  payload,
  orgId: null,
  actorId: null,
  requestId: null,
  occurredAt: new Date().toISOString(),
  source: "app",
});

describe("notifications service", () => {
  let app: INestApplicationContext;
  let testDb: TestDatabase;
  let producer: Producer<"notifications-critical">;
  let events: Producer<"events-notifications">;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // The service connects as its own least-privileged role, exactly as in production.
    process.env.NOTIFICATIONS_DATABASE_URL = testDb.urlFor("app_notifications");
    // A private Redis database, so a notifications service running locally for
    // development can't take this test's jobs (the API tests use 13).
    process.env.REDIS_URL = redisDatabase(14);
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
    events = createProducer("events-notifications", createRedis(env.REDIS_URL));
  });

  afterAll(async () => {
    await producer?.close();
    await events?.close();
    await app?.close();
    await testDb?.drop();
  });

  async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
    const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(query, params)).rows as T[];
    } finally {
      await client.end();
    }
  }

  /** The delivery log's settled rows for a job or event. */
  function settle(key: string) {
    return eventually(
      () =>
        sql<{ status: string }>(
          "SELECT status FROM notifications.delivery WHERE idempotency_key LIKE $1 AND status <> 'sending'",
          [`${key}:%`],
        ),
      (rows) => rows.length >= 1,
    );
  }

  /** Waits until BullMQ has finished the job, one way or the other. */
  function finished(queue: Queue, jobId: string) {
    return eventually(
      async () => (await queue.getJob(jobId))?.getState(),
      (state) => state === "completed" || state === "failed",
    );
  }

  it("delivers a sign-in code email through the queue", async () => {
    const to = `otp-${randomUUID()}@test.dev`;
    await producer.add(
      "send",
      {
        template: "auth.otp",
        to: { email: to, locale: "en" },
        data: { otp: "314159", purpose: "email-verification", expiresInMinutes: 5 },
      },
      { jobId: randomUUID() },
    );

    const message = await waitForEmail(to);
    expect(message.Subject).toBe("Verify your email");
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
      Text: string;
      HTML: string;
    };
    expect(full.Text).toContain("314159");
    expect(full.Text).toContain("This code expires in 5 minutes.");
    expect(full.HTML).toContain('lang="en"');
  });

  it("deletes jobs as soon as they complete, so one-time codes never linger in Redis", async () => {
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
          to: { email: "not-an-email", locale: "en" },
          data: { otp: "1", purpose: "email-verification", expiresInMinutes: 5 },
        },
        { jobId: randomUUID() },
      ),
    ).rejects.toThrow();
  });

  it("the same job twice sends one email", async () => {
    const email = `once-${randomUUID()}@test.dev`;
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const dispatcher = app.get(Dispatcher);
    const key = randomUUID();
    // As when a job is retried or an event is redelivered.
    await dispatcher.dispatch(securityAlert(email), key);
    await dispatcher.dispatch(securityAlert(email), key);
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
    expect(await emailsTo(email)).toHaveLength(1);
  });

  it("never emails a suppressed address", async () => {
    const email = `suppressed-${randomUUID()}@test.dev`;
    await sql(
      "INSERT INTO notifications.suppression (channel, address, reason) VALUES ('email', $1, 'bounce')",
      [email],
    );
    const jobId = randomUUID();
    await producer.add("send", securityAlert(email), { jobId });
    expect((await settle(jobId)).map((row) => row.status)).toEqual(["suppressed"]);
  });

  it("stops emailing an address the provider reports bounced, whatever it says later", async () => {
    const email = `bounced-${randomUUID()}@test.dev`;
    const queue = new Queue("events-notifications", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("events-notifications"),
    });
    /** Queues the event and waits until the service has handled it. */
    const feedback = async (kind: "bounce" | "complaint") => {
      // In whatever case the mail server reported the address.
      const event = eventOf("email.feedback_received.v1", {
        provider: "stalwart",
        kind,
        address: email.toUpperCase(),
      });
      await events.add("event", event, { jobId: event.id });
      await expect.poll(() => queue.getJobState(event.id), { timeout: 10_000 }).toBe("completed");
    };
    const reasons = async () =>
      (
        await sql<{ reason: string }>(
          "SELECT reason FROM notifications.suppression WHERE channel = 'email' AND address = $1",
          [email],
        )
      ).map((row) => row.reason);

    await feedback("bounce");
    expect(await reasons()).toEqual(["bounce"]);
    // A later report doesn't change it: the first reason stands.
    await feedback("complaint");
    expect(await reasons()).toEqual(["bounce"]);
    await queue.close();

    const jobId = randomUUID();
    await producer.add("send", securityAlert(email), { jobId });
    expect((await settle(jobId)).map((row) => row.status)).toEqual(["suppressed"]);
  });

  it("sends a notification asked for in the outbox, once however often it arrives", async () => {
    const email = `outbox-${randomUUID()}@test.dev`;
    const event = eventOf("notification.requested.v1", { notification: securityAlert(email) });
    await events.add("event", event, { jobId: event.id });
    await events.add("event", event, { jobId: `${event.id}-again` });
    await settle(event.id);
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
    const sent = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications.delivery WHERE idempotency_key LIKE $1",
      [`${event.id}:%`],
    );
    expect(sent[0]?.n).toBe(1);
  });

  it("records a send that failed and throws, so the job's retry sends it again", async () => {
    const { Dispatcher } = await import("../src/dispatch/dispatcher");
    const { EmailChannel } = await import("../src/channels/email/email.channel");
    const channel = app.get(EmailChannel);
    const send = channel.send.bind(channel);
    channel.send = () => Promise.reject(new Error("SMTP down"));
    const key = randomUUID();
    const email = `retry-${randomUUID()}@test.dev`;
    try {
      await expect(app.get(Dispatcher).dispatch(securityAlert(email), key)).rejects.toThrow(
        "SMTP down",
      );
    } finally {
      channel.send = send;
    }
    expect(
      await sql("SELECT status, error FROM notifications.delivery WHERE idempotency_key LIKE $1", [
        `${key}:%`,
      ]),
    ).toEqual([{ status: "failed", error: "SMTP down" }]);
    // The retry claims the failed send again, and this time it goes.
    await app.get(Dispatcher).dispatch(securityAlert(email), key);
    expect((await waitForEmail(email)).Subject).toBe("Your password was changed");
  });

  it("fails a job the queue doesn't know", async () => {
    const mystery = randomUUID();
    await producer.queue.add("mystery", { meta: {}, payload: {} } as never, {
      jobId: mystery,
      attempts: 1,
    });
    expect(await finished(producer.queue, mystery)).toBe("failed");
    expect((await producer.queue.getJob(mystery))?.failedReason).toBe(
      'Unknown job "mystery" on notifications-critical',
    );
  });

  it("ignores events that notify nobody", async () => {
    // Not an event this service is routed.
    const event = eventOf("auth.password_changed.v1", { userId: randomUUID() });
    await events.add("event", event, { jobId: event.id });
    expect(await finished(events.queue, event.id)).toBe("completed");
    expect(
      await sql("SELECT 1 FROM notifications.delivery WHERE idempotency_key LIKE $1", [
        `${event.id}:%`,
      ]),
    ).toEqual([]);
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
