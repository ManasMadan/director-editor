/**
 * The real mail path against the compose `stalwart` service (`bun run db:up:mail`):
 * authenticated submission over TLS, delivery (relayed to Mailpit, DKIM-signed on the
 * way), and a bounce that Stalwart reports to this service's /webhooks/stalwart, signed,
 * where it becomes the feedback event apps/notifications suppresses the address on
 * (that last hop is covered by the notifications integration test).
 *
 * Skipped unless STALWART_URL (its management API) is set. The test registers its own
 * webhook through that API, pointing at this process on host.docker.internal, so it
 * doesn't need the webhooks service from `bun dev` and can't be confused by it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { createRedis } from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import nodemailer from "nodemailer";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const STALWART_URL = process.env.STALWART_URL;
const ADMIN = `admin:${process.env.STALWART_ADMIN_PASSWORD ?? "stalwart-admin"}`;
// The compose service's defaults: the no-reply account over implicit TLS, trusting its
// self-signed certificate.
const SMTP_URL =
  process.env.STALWART_SMTP_URL ??
  "smtps://no-reply:no-reply-password@localhost:51465?tls.rejectUnauthorized=false";
// The Mailpit Stalwart relays to: compose's. In CI that isn't the job's own Mailpit.
const MAILPIT =
  process.env.STALWART_MAILPIT_URL ?? process.env.MAILPIT_URL ?? "http://localhost:58025";
const FROM = "Boilerplate <no-reply@boilerplate.test>";
const SECRET = randomBytes(32).toString("base64");

/** One call to Stalwart's management API (JMAP), as the admin. */
async function jmap(method: string, args: Record<string, unknown>) {
  const response = await fetch(`${STALWART_URL}/jmap`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(ADMIN).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: [[method, args, "c"]],
    }),
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { methodResponses: [string, Record<string, unknown>][] };
  const [name, result] = body.methodResponses[0] ?? [];
  const failed = result?.notCreated ?? result?.notDestroyed;
  if (name === "error" || (failed && Object.keys(failed).length > 0)) {
    throw new Error(`${method}: ${JSON.stringify(result)}`);
  }
  return result ?? {};
}
/** Settings written through the API apply on a reload. */
const reload = () => jmap("x:Action/set", { create: { r: { "@type": "ReloadSettings" } } });

describe.skipIf(!STALWART_URL)("mail through Stalwart", () => {
  let testDb: TestDatabase;
  let app: NestFastifyApplication;
  let webhookId: string | undefined;

  const sql = async (text: string, values: unknown[]) => {
    const client = new pg.Client({ connectionString: testDb.urlFor("postgres") });
    await client.connect();
    try {
      return (await client.query(text, values)).rows;
    } finally {
      await client.end();
    }
  };
  const send = (to: string, url = SMTP_URL) =>
    nodemailer.createTransport(url).sendMail({
      from: FROM,
      to,
      subject: `Stalwart test ${randomUUID()}`,
      text: "Sent by apps/webhooks/test/stalwart.integration.test.ts",
    });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    Object.assign(process.env, {
      WEBHOOKS_DATABASE_URL: testDb.urlFor("app_webhooks"),
      LOAD_SHEDDING: "off",
      REDIS_URL: redisDatabase(16),
      ENCRYPTION_KEYS: `test:${randomBytes(32).toString("base64")}`,
      STALWART_WEBHOOK_SECRET: SECRET,
    });
    const redis = createRedis(process.env.REDIS_URL as string);
    await flushTestDatabase(redis);
    await redis.quit();
    const { createWebhooksServer } = await import("../src/server");
    app = await createWebhooksServer();
    // Every interface: the container reaches the host through the Docker gateway.
    await app.listen({ port: 0, host: "0.0.0.0" });
    const { port } = app.getHttpServer().address() as AddressInfo;

    const created = await jmap("x:WebHook/set", {
      create: {
        test: {
          url: `http://host.docker.internal:${port}/webhooks/stalwart`,
          events: { "delivery.dsn-perm-fail": true, "delivery.dsn-temp-fail": true },
          eventsPolicy: "include",
          signatureKey: { "@type": "Value", secret: SECRET },
          httpAuth: { "@type": "Unauthenticated" },
          httpHeaders: {},
        },
      },
    });
    webhookId = (created.created as Record<string, { id: string }>).test?.id;
    await reload();
  });

  afterAll(async () => {
    if (webhookId) {
      await jmap("x:WebHook/set", { destroy: [webhookId] });
      await reload();
    }
    await app?.close();
    await testDb?.drop();
  });

  it("accepts an authenticated submission and delivers it, DKIM-signed", async () => {
    const to = `delivered-${randomUUID()}@example.org`;
    const info = await send(to);
    expect(info.accepted).toEqual([to]);
    expect(info.response).toMatch(/^250 .*queued/i);

    const found = await eventually(
      async () => {
        const response = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        return ((await response.json()) as { messages: { ID: string }[] }).messages;
      },
      (messages) => messages.length > 0,
      { timeout: 20_000, interval: 250 },
    );
    expect(found).toHaveLength(1);
    const headers = (await (
      await fetch(`${MAILPIT}/api/v1/message/${found[0]?.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["Dkim-Signature"]?.join(" ")).toMatch(/d=boilerplate\.test/);
  });

  it("refuses submission with a wrong password or none", async () => {
    const wrong = new URL(SMTP_URL);
    wrong.password = "not-the-password";
    await expect(send(`nobody-${randomUUID()}@example.org`, wrong.toString())).rejects.toThrow(
      /535|auth/i,
    );
    const anonymous = new URL(SMTP_URL);
    anonymous.username = "";
    anonymous.password = "";
    await expect(
      send(`nobody-${randomUUID()}@example.org`, anonymous.toString()),
    ).rejects.toThrow();
  });

  it("turns a bounce from the remote server into feedback for that address", {
    timeout: 60_000,
  }, async () => {
    // bounce.test is refused by the server with 550 5.1.2 (see docker-compose.yml).
    const to = `gone-${randomUUID()}@bounce.test`;
    expect((await send(to)).accepted).toEqual([to]);

    const feedback = await eventually(
      () =>
        sql(
          "SELECT payload FROM webhooks.outbox_event WHERE name = 'email.feedback_received.v1' AND payload->>'address' = $1",
          [to],
        ),
      (rows) => rows.length > 0,
      { timeout: 45_000, interval: 250 },
    );
    expect(feedback.map((row) => row.payload)).toEqual([
      { provider: "stalwart", kind: "bounce", address: to },
    ]);
    const stored = await sql(
      "SELECT type, payload FROM webhooks.inbound_event WHERE provider = 'stalwart' AND payload->'data'->>'to' = $1",
      [to],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      type: "delivery.dsn-perm-fail",
      payload: { data: { to, details: expect.stringContaining("5.1.2") } },
    });
  });
});
