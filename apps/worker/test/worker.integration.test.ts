/**
 * The worker against a real (cloned) database and a private Redis database: outbox relay,
 * audit log, retention and the database guarantees behind them.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { fileIdSchema } from "@repo/contracts/ids";
import { createTestDatabase, type TestDatabase } from "@repo/db/testing";
import { queuePrefix } from "@repo/jobs";
import {
  createRedis,
  DATABASE,
  type Database,
  type PinoLogger,
  S3Storage,
} from "@repo/nest-common";
import { flushTestDatabase, redisDatabase } from "@repo/nest-common/testing";
import { eventually } from "@repo/testing/eventually";
import { type Clamd, clamdFor } from "@repo/testing/fake-clamd";
import { Queue } from "bullmq";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FilesProcessor as Files } from "../src/files/files.processor";
import type { MaintenanceProcessor as Maintenance } from "../src/maintenance/maintenance.processor";
import type { OutboxRelay as Relay } from "../src/outbox/relay.service";

let testDb: TestDatabase;
let app: INestApplicationContext;
let relay: Relay;
let maintenance: Maintenance;
let files: Files;
let clamd: Clamd;

// Local object storage (docker compose --profile files) and clamd: ClamAV in CI, and
// locally when it runs, else the stand-in from @repo/testing/fake-clamd.
const S3 = {
  S3_BUCKET: process.env.S3_BUCKET ?? "uploads",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:59000",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "rustfs",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "rustfs-secret",
  S3_FORCE_PATH_STYLE: "true",
};
const storage = new S3Storage({
  bucket: S3.S3_BUCKET,
  region: "us-east-1",
  endpoint: S3.S3_ENDPOINT,
  accessKeyId: S3.S3_ACCESS_KEY_ID,
  secretAccessKey: S3.S3_SECRET_ACCESS_KEY,
  forcePathStyle: true,
});

async function asRole<T>(role: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Emits events the way apps/api does: an outbox row plus a NOTIFY, in one transaction. */
async function emit(count: number, orgId: string | null = randomUUID()) {
  const ids: string[] = [];
  await asRole("app_api", async (client) => {
    await client.query("BEGIN");
    for (let i = 0; i < count; i++) {
      const todoId = randomUUID();
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.outbox_event (name, key, payload, org_id)
         VALUES ('todo.created.v1', $1, $2, $3) RETURNING id`,
        [todoId, JSON.stringify({ todoId, title: `Task ${i}` }), orgId],
      );
      ids.push(rows[0]?.id as string);
    }
    await client.query("SELECT pg_notify('outbox', 'app')");
    await client.query("COMMIT");
  });
  return ids;
}

/**
 * Which of these event ids are in the audit log. Read as the database superuser: the test
 * observes rows across organizations, which no application role can (row-level security).
 */
async function audited(ids: string[]) {
  return asRole("postgres", async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM audit.audit_log WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return rows.map((row) => row.id);
  });
}

/** A port nothing listens on yet (for the service main.ts starts). */
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A job on one of the worker's queues, as BullMQ has it. */
async function jobIn(queue: string, jobId: string) {
  const bull = new Queue(queue, {
    connection: createRedis(process.env.REDIS_URL as string),
    prefix: queuePrefix(queue),
  });
  const job = await bull.getJob(jobId);
  const state = await job?.getState();
  await bull.close();
  return { job, state };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  // ClamAV when it's running (always in CI), else the stand-in that finds EICAR.
  clamd = await clamdFor(process.env.CLAMAV_URL ?? "tcp://localhost:53310");
  Object.assign(process.env, {
    WORKER_DATABASE_URL: testDb.urlFor("app_worker"),
    WORKER_DATABASE_DIRECT_URL: testDb.urlFor("app_worker"),
    REDIS_URL: redisDatabase(15),
    RELAY_POLL_INTERVAL_MS: "200",
    ...S3,
    CLAMAV_URL: clamd.url,
    // For the service main.ts starts, at the end.
    PORT: String(await freePort()),
    LOAD_SHEDDING: "off",
  });
  const redis = createRedis(process.env.REDIS_URL as string);
  await flushTestDatabase(redis);
  await redis.quit();
  const { AppModule } = await import("../src/app.module");
  const { OutboxRelay } = await import("../src/outbox/relay.service");
  const { MaintenanceProcessor } = await import("../src/maintenance/maintenance.processor");
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  relay = app.get(OutboxRelay);
  maintenance = app.get(MaintenanceProcessor);
  const { FilesProcessor } = await import("../src/files/files.processor");
  files = app.get(FilesProcessor);
});

afterAll(async () => {
  await app?.close();
  await clamd?.close();
  await testDb?.drop();
});

describe("outbox relay", () => {
  it("delivers a committed event to the audit log within moments", async () => {
    const [id] = await emit(1);
    const rows = await eventually(
      () => audited([id as string]),
      (found) => found.length === 1,
    );
    expect(rows).toEqual([id]);
  });

  it("drains a backlog larger than one batch, publishing every event exactly once", async () => {
    const ids = await emit(250);
    // A second relay competing for the same rows, as another replica would.
    await Promise.all([relay.drainBatch("app"), relay.drainBatch("app"), relay.drainBatch("app")]);
    const rows = await eventually(
      () => audited(ids),
      (found) => found.length === ids.length,
    );
    expect(new Set(rows).size).toBe(250);
    const unpublished = await asRole("app_worker", async (client) => {
      const { rows: left } = await client.query(
        "SELECT count(*)::int AS n FROM app.outbox_event WHERE published_at IS NULL AND id = ANY($1::uuid[])",
        [ids],
      );
      return left[0].n as number;
    });
    expect(unpublished).toBe(0);
  });

  it("passes on an event this build doesn't know, without holding up the rest", async () => {
    // As during a rolling deploy: a newer api emits an event this worker predates.
    const [unknown] = await asRole("app_api", async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.outbox_event (name, key, payload, org_id)
         VALUES ('invoice.paid.v1', 'inv_1', '{"amount": 100}', $1) RETURNING id`,
        [randomUUID()],
      );
      return rows.map((row) => row.id);
    });
    const later = await emit(3);
    const ids = [unknown as string, ...later];
    const rows = await eventually(
      () => audited(ids),
      (found) => found.length === ids.length,
    );
    expect(rows.sort()).toEqual(ids.sort());
  });

  it("sets aside a row that isn't a valid event, instead of blocking every batch after it", async () => {
    const [poison] = await asRole("app_api", async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.outbox_event (name, key, payload, org_id)
         VALUES ('Not a valid name!', 'k', '{}', $1) RETURNING id`,
        [randomUUID()],
      );
      return rows.map((row) => row.id);
    });
    const later = await emit(2);
    const rows = await eventually(
      () => audited(later),
      (found) => found.length === later.length,
    );
    expect(rows.sort()).toEqual([...later].sort());
    const setAside = await asRole("postgres", async (client) => {
      const { rows: left } = await client.query(
        "SELECT published_at FROM app.outbox_event WHERE id = $1",
        [poison],
      );
      return left[0]?.published_at as Date | null;
    });
    expect(setAside).toBeInstanceOf(Date);
    expect(await audited([poison as string])).toEqual([]);
  });

  it("republishing a batch (a crash before commit) doesn't duplicate audit rows", async () => {
    const [id] = await emit(1);
    await eventually(
      () => audited([id as string]),
      (found) => found.length === 1,
    );
    // Put the row back as unpublished, as if the commit never happened, and relay again.
    await asRole("migrator", (client) =>
      client.query("UPDATE app.outbox_event SET published_at = NULL WHERE id = $1", [id]),
    );
    relay.kick();
    await eventually(
      () =>
        asRole("app_worker", async (client) => {
          const { rows } = await client.query(
            "SELECT published_at FROM app.outbox_event WHERE id = $1",
            [id],
          );
          return rows[0]?.published_at as Date | null;
        }),
      (published) => published !== null,
    );
    expect(await audited([id as string])).toEqual([id]);
  });
});

describe("outbox relay, when things go wrong", () => {
  const listeners = async () =>
    (
      await asRole("postgres", (client) =>
        client.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = $1 AND application_name = 'worker-outbox-listener'",
          [testDb.name],
        ),
      )
    ).rows.map((row) => row.pid);

  it("reconnects its listener after losing the connection", async () => {
    const pids = await listeners();
    expect(pids).toHaveLength(1);
    const [before] = pids;
    await asRole("postgres", (client) => client.query("SELECT pg_terminate_backend($1)", [before]));
    const after = await eventually(listeners, (pids) => pids.length === 1 && pids[0] !== before);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);
    const [id] = await emit(1);
    expect(
      await eventually(
        () => audited([id as string]),
        (found) => found.length === 1,
      ),
    ).toEqual([id]);
  });

  it("hands on who caused an event, and audits one without a payload", async () => {
    const [actorId, orgId] = [randomUUID(), randomUUID()];
    const [id] = await asRole("app_api", async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO app.outbox_event (name, key, payload, org_id, actor_id, request_id)
         VALUES ('todo.created.v1', 'k', 'null', $1, $2, 'req-7') RETURNING id`,
        [orgId, actorId],
      );
      return inserted.rows.map((row) => row.id);
    });
    await eventually(
      () => audited([id as string]),
      (found) => found.length === 1,
    );
    const [entry] = (
      await asRole("postgres", (client) =>
        client.query("SELECT payload, actor_id, request_id FROM audit.audit_log WHERE id = $1", [
          id,
        ]),
      )
    ).rows;
    expect(entry).toEqual({ payload: {}, actor_id: actorId, request_id: "req-7" });
    const { job } = await jobIn("events-audit", id as string);
    expect(job?.data.meta).toEqual({ requestId: "req-7", userId: actorId, orgId });
  });

  it("nudges no screen for a todo event without an organization", async () => {
    const [id] = await emit(1, null);
    // Audited means relayed: its realtime job was queued in the same step.
    await eventually(
      () => audited([id as string]),
      (found) => found.length === 1,
    );
    // Done jobs leave that queue at once; a failed one would stay.
    const settled = await eventually(
      () => jobIn("events-realtime", id as string),
      ({ state }) => state === undefined,
    );
    expect(settled.state).toBeUndefined();
  });
});

describe("audit log guarantees", () => {
  it("is append-only: the worker can't change or delete rows, the api can't write", async () => {
    const [id] = await emit(1);
    await eventually(
      () => audited([id as string]),
      (found) => found.length === 1,
    );
    await expect(
      asRole("app_worker", (client) => client.query("UPDATE audit.audit_log SET name = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole("app_worker", (client) => client.query("DELETE FROM audit.audit_log")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole("app_api", (client) =>
        client.query(
          `INSERT INTO audit.audit_log (id, occurred_at, name, key, payload, source)
           VALUES (gen_random_uuid(), now(), 'x', 'x', '{}', 'app')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("the api reads only the current organization's events", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const [a] = await emit(1, orgA);
    const [b] = await emit(1, orgB);
    await eventually(
      () => audited([a as string, b as string]),
      (found) => found.length === 2,
    );
    const seen = await asRole("app_api", async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      const { rows } = await client.query<{ id: string }>("SELECT id FROM audit.audit_log");
      await client.query("COMMIT");
      return rows.map((row) => row.id);
    });
    expect(seen).toEqual([a]);
    const unscoped = await asRole("app_api", async (client) => {
      const { rows } = await client.query("SELECT id FROM audit.audit_log");
      return rows;
    });
    expect(unscoped).toEqual([]);
  });
});

describe("maintenance", () => {
  it("keeps partitions around now and drops months past retention", async () => {
    const result = await maintenance.run("audit-partitions");
    expect(result.created).toBe(0); // boot already created them
    const partitions = await asRole("migrator", async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'audit.audit_log'::regclass ORDER BY 1`,
      );
      return rows.map((row) => row.relname);
    });
    expect(partitions).toHaveLength(5);

    // An old partition (as if the service had run for years) is dropped by retention.
    await asRole("migrator", (client) =>
      client.query(
        `CREATE TABLE audit.audit_log_2020_01 PARTITION OF audit.audit_log
         FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
      ),
    );
    expect((await maintenance.run("audit-partitions")).dropped).toBe(1);
  });

  it("deletes only published outbox rows older than the retention window", async () => {
    const [old, recent] = await emit(2);
    await eventually(
      () => audited([old as string, recent as string]),
      (found) => found.length === 2,
    );
    const [pending] = await emit(1);
    await asRole("migrator", (client) =>
      client.query(
        `UPDATE app.outbox_event SET published_at = now() - interval '30 days' WHERE id = $1`,
        [old],
      ),
    );
    await asRole("migrator", (client) =>
      client.query("UPDATE app.outbox_event SET published_at = NULL WHERE id = $1", [pending]),
    );
    await maintenance.run("outbox-retention");
    const remaining = await asRole("app_worker", async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM app.outbox_event WHERE id = ANY($1::uuid[])",
        [[old, recent, pending]],
      );
      return rows.map((row) => row.id).sort();
    });
    expect(remaining).toEqual([recent, pending].sort());
  });

  it("purges old webhook deliveries, but keeps pending and recent ones", async () => {
    const orgId = randomUUID();
    const ids = await asRole("postgres", async (client) => {
      await client.query(
        `INSERT INTO auth.organization (id, name, slug, created_at) VALUES ($1::uuid, 'W', $1::text, now())`,
        [orgId],
      );
      const endpoint = await client.query<{ id: string }>(
        `INSERT INTO webhooks.endpoint (org_id, url, secret, updated_at)
         VALUES ($1, 'https://example.com/hook', 's', now()) RETURNING id`,
        [orgId],
      );
      const deliveries = await client.query<{ id: string; event_name: string }>(
        `INSERT INTO webhooks.delivery (endpoint_id, org_id, event_id, event_name, body, status, created_at)
         VALUES ($1, $2, uuidv7(), 'old-sent', '{}', 'succeeded', now() - interval '200 days'),
                ($1, $2, uuidv7(), 'old-pending', '{}', 'pending', now() - interval '200 days'),
                ($1, $2, uuidv7(), 'recent', '{}', 'failed', now())
         RETURNING id, event_name`,
        [endpoint.rows[0]?.id, orgId],
      );
      return deliveries.rows;
    });
    expect(ids).toHaveLength(3);

    const result = await maintenance.run("outbox-retention");
    expect(result["webhooks.history"]).toBeGreaterThanOrEqual(1);
    const left = await asRole("postgres", async (client) => {
      const { rows } = await client.query<{ event_name: string }>(
        "SELECT event_name FROM webhooks.delivery WHERE org_id = $1 ORDER BY event_name",
        [orgId],
      );
      return rows.map((row) => row.event_name);
    });
    expect(left).toEqual(["old-pending", "recent"]);
  });

  it("purges old notification history, but keeps unread notifications", async () => {
    const userId = randomUUID();
    await asRole("app_api", (client) =>
      client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`,
        [userId, `${userId}@test.dev`],
      ),
    );
    await asRole("postgres", async (client) => {
      await client.query(
        `INSERT INTO notifications.notification (user_id, template, data, read_at, created_at) VALUES
         ($1, 'old-read', '{}', now() - interval '200 days', now() - interval '200 days'),
         ($1, 'old-unread', '{}', NULL, now() - interval '200 days'),
         ($1, 'recent-read', '{}', now() - interval '1 day', now() - interval '2 days')`,
        [userId],
      );
      await client.query(
        `INSERT INTO notifications.delivery (idempotency_key, channel, template, user_id, status, created_at, updated_at) VALUES
         ($2, 'email', 't', $1, 'sent', now() - interval '200 days', now()),
         ($3, 'email', 't', $1, 'sent', now(), now())`,
        [userId, `old-${userId}`, `new-${userId}`],
      );
    });
    const result = await maintenance.run("outbox-retention");
    expect(result["notifications.history"]).toBeGreaterThanOrEqual(2);
    const left = await asRole("postgres", async (client) => ({
      notifications: (
        await client.query<{ template: string }>(
          "SELECT template FROM notifications.notification WHERE user_id = $1 ORDER BY template",
          [userId],
        )
      ).rows.map((row) => row.template),
      deliveries: (
        await client.query<{ idempotency_key: string }>(
          "SELECT idempotency_key FROM notifications.delivery WHERE user_id = $1",
          [userId],
        )
      ).rows.map((row) => row.idempotency_key),
    }));
    expect(left).toEqual({
      notifications: ["old-unread", "recent-read"],
      deliveries: [`new-${userId}`],
    });
  });

  it("purges expired database sessions and verifications", async () => {
    const userId = randomUUID();
    await asRole("app_api", async (client) => {
      await client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`,
        [userId, `${userId}@test.dev`],
      );
      await client.query(
        `INSERT INTO auth.session (token, user_id, expires_at, updated_at) VALUES
         ($1, $3, now() - interval '1 day', now()), ($2, $3, now() + interval '1 day', now())`,
        [`expired-${userId}`, `live-${userId}`, userId],
      );
    });
    await maintenance.run("session-retention");
    const tokens = await asRole("app_api", async (client) => {
      const { rows } = await client.query<{ token: string }>(
        "SELECT token FROM auth.session WHERE user_id = $1",
        [userId],
      );
      return rows.map((row) => row.token);
    });
    expect(tokens).toEqual([`live-${userId}`]);
  });

  it("purges expired OAuth tokens and spent client assertions", async () => {
    const userId = randomUUID();
    const clientId = `client-${userId}`;
    await asRole("app_api", async (client) => {
      await client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`,
        [userId, `${userId}@test.dev`],
      );
      await client.query(`INSERT INTO auth.oauth_client (client_id) VALUES ($1)`, [clientId]);
      for (const table of ["oauth_refresh_token", "oauth_access_token"]) {
        await client.query(
          `INSERT INTO auth.${table} (token, client_id, user_id, expires_at) VALUES
           ($1, $3, $4, now() - interval '1 minute'), ($2, $3, $4, now() + interval '1 day')`,
          [`expired-${table}-${userId}`, `live-${table}-${userId}`, clientId, userId],
        );
      }
      await client.query(
        `INSERT INTO auth.oauth_client_assertion (id, expires_at) VALUES
         ($1, now() - interval '1 minute'), ($2, now() + interval '1 hour')`,
        [`spent-${userId}`, `fresh-${userId}`],
      );
    });
    await maintenance.run("session-retention");
    const left = await asRole("app_api", async (client) => {
      const tokens = async (table: string) =>
        (
          await client.query<{ token: string }>(
            `SELECT token FROM auth.${table} WHERE user_id = $1`,
            [userId],
          )
        ).rows.map((row) => row.token);
      const assertions = await client.query<{ id: string }>(
        "SELECT id FROM auth.oauth_client_assertion WHERE id = ANY($1)",
        [[`spent-${userId}`, `fresh-${userId}`]],
      );
      return {
        refresh: await tokens("oauth_refresh_token"),
        access: await tokens("oauth_access_token"),
        assertions: assertions.rows.map((row) => row.id),
      };
    });
    expect(left).toEqual({
      refresh: [`live-oauth_refresh_token-${userId}`],
      access: [`live-oauth_access_token-${userId}`],
      assertions: [`fresh-${userId}`],
    });
  });

  it("runs a task when its schedule comes round", async () => {
    const queue = new Queue("maintenance", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("maintenance"),
    });
    const job = await queue.add("session-retention", { meta: {}, payload: {} });
    const done = await eventually(
      () => job.isCompleted(),
      (completed) => completed,
    );
    expect(done).toBe(true);
    await queue.close();
  });

  it("forgets abandoned uploads, and removes queued objects however many there are", {
    tags: ["files"],
  }, async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const userId = randomUUID();
    const fileId = randomUUID();
    await asRole("postgres", async (client) => {
      await client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`,
        [userId, `${userId}@test.dev`],
      );
      await client.query(
        `INSERT INTO files.file (id, user_id, purpose, filename, declared_type, declared_size, created_at, updated_at)
         VALUES ($1, $2, 'avatar', 'me.png', 'image/png', $3, now() - interval '2 days', now())`,
        [fileId, userId, png.length],
      );
      // More than one batch of objects left behind by deleted files.
      await client.query(
        "INSERT INTO files.object_deletion (key) SELECT 'files/gone-' || $1 || '-' || n FROM generate_series(1, 501) n",
        [fileId],
      );
    });
    await storage.write(`quarantine/${fileId}`, png, "image/png");

    const result = await maintenance.run("files-cleanup");
    expect(result.stale).toBeGreaterThanOrEqual(1);
    expect(result.objects).toBeGreaterThanOrEqual(503);
    expect(await storage.head(`quarantine/${fileId}`)).toBeNull();
    expect(await maintenance.run("files-cleanup")).toEqual({ stale: 0, objects: 0 });

    // With files off there's no storage to clean.
    const { FilesCleanup } = await import("../src/files/files.cleanup");
    expect(await new FilesCleanup(app.get<Database>(DATABASE), null).run()).toEqual({
      stale: 0,
      objects: 0,
    });
  });

  it("registers every schedule with BullMQ once", async () => {
    const queue = new Queue("maintenance", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("maintenance"),
    });
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort()).toEqual([
      "audit-partitions",
      "files-cleanup",
      "outbox-retention",
      "session-retention",
    ]);
    await queue.close();
  });

  it("the worker can't run the functions' SQL itself", async () => {
    await expect(
      asRole("app_worker", (client) => client.query("DELETE FROM app.outbox_event")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole("app_api", (client) => client.query("SELECT auth.purge_expired()")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("uploads", { tags: ["files"] }, () => {
  // The EICAR test file: every antivirus detects it, and it's harmless.
  const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  async function newUser() {
    const userId = randomUUID();
    await asRole("app_api", (client) =>
      client.query(
        `INSERT INTO auth."user" (id, name, email, updated_at) VALUES ($1, 'U', $2, now())`,
        [userId, `${userId}@test.dev`],
      ),
    );
    return userId;
  }

  /** An upload as the browser leaves it: a pending row and the bytes in quarantine. */
  async function upload(bytes: Buffer, declaredType = "image/png", declaredSize = bytes.length) {
    const userId = await newUser();
    const fileId = fileIdSchema.parse(randomUUID());
    await asRole("postgres", (client) =>
      client.query(
        `INSERT INTO files.file (id, user_id, purpose, filename, declared_type, declared_size, updated_at)
         VALUES ($1, $2, 'avatar', 'me.png', $3, $4, now())`,
        [fileId, userId, declaredType, declaredSize],
      ),
    );
    await storage.write(`quarantine/${fileId}`, bytes, declaredType);
    return { userId, fileId };
  }

  async function row(fileId: string) {
    return asRole("postgres", async (client) => {
      const { rows } = await client.query(
        "SELECT status, reject_reason, content_type, size, sha256, ready_at FROM files.file WHERE id = $1",
        [fileId],
      );
      return rows[0];
    });
  }

  async function photoWithMetadata() {
    return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#3366cc" } })
      .jpeg()
      .withExif({ IFD0: { Artist: "Secret Name", Copyright: "GPS 51.5,-0.12" } })
      .toBuffer();
  }

  it("accepts a photo as a 512px WebP with its metadata gone", async () => {
    const photo = await photoWithMetadata();
    expect((await sharp(photo).metadata()).exif?.includes("Secret Name")).toBe(true);
    const { fileId, userId } = await upload(photo, "image/jpeg");

    // The uploader's screens are told when it's done.
    const subscriber = createRedis(process.env.REDIS_URL as string);
    const messages: string[] = [];
    await subscriber.subscribe(`realtime:user:${userId}`);
    subscriber.on("message", (_channel, message) => messages.push(message));

    await files.check(fileId);
    const stored = await storage.read(`files/${fileId}`, 10_000_000);
    const metadata = await sharp(stored).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined();
    expect(stored.includes(Buffer.from("Secret Name"))).toBe(false);
    expect(await storage.head(`quarantine/${fileId}`)).toBeNull();
    expect(await row(fileId)).toMatchObject({
      status: "ready",
      reject_reason: null,
      content_type: "image/webp",
      size: stored.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      ready_at: expect.any(Date),
    });
    await eventually(
      async () => messages,
      (received) => received.length > 0,
    );
    expect(messages.map((message) => JSON.parse(message))).toContainEqual({
      type: "files.changed",
    });
    await subscriber.quit();
  });

  it("rejects a virus, whatever it claims to be, and deletes it", async () => {
    const { fileId } = await upload(Buffer.from(EICAR));
    await files.check(fileId);
    expect(await row(fileId)).toMatchObject({ status: "rejected", reject_reason: "FILE_INFECTED" });
    expect(await storage.head(`quarantine/${fileId}`)).toBeNull();
    expect(await storage.head(`files/${fileId}`)).toBeNull();
  });

  it("only cleans up after an attempt that decided but crashed before removing the original", async () => {
    const { fileId } = await upload(Buffer.from("already checked"));
    await asRole("postgres", (client) =>
      client.query("UPDATE files.file SET status = 'ready', ready_at = now() WHERE id = $1", [
        fileId,
      ]),
    );
    await files.check(fileId);
    expect(await row(fileId)).toMatchObject({ status: "ready" });
    expect(await storage.head(`quarantine/${fileId}`)).toBeNull();
  });

  it("judges the type by the bytes, not by what the client said", async () => {
    const { fileId } = await upload(Buffer.from("<svg onload=alert(1)></svg>"), "image/png");
    await files.check(fileId);
    expect(await row(fileId)).toMatchObject({
      status: "rejected",
      reject_reason: "FILE_TYPE_NOT_ALLOWED",
    });
  });

  it("rejects an image that doesn't decode", async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } })
      .jpeg()
      .toBuffer();
    // Recognisably a JPEG from its first bytes, then garbage the decoder chokes on.
    const broken = Buffer.concat([jpeg.subarray(0, 20), Buffer.alloc(200, 0xab)]);
    const { fileId } = await upload(broken, "image/jpeg");
    await files.check(fileId);
    expect(await row(fileId)).toMatchObject({
      status: "rejected",
      reject_reason: "FILE_UNREADABLE",
    });
  });

  it("rejects an object that isn't the size that was signed for", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const { fileId } = await upload(png, "image/png", png.length + 10);
    await files.check(fileId);
    // Smaller than declared isn't "too large": it has its own reason.
    expect(await row(fileId)).toMatchObject({
      status: "rejected",
      reject_reason: "FILE_SIZE_MISMATCH",
    });
  });

  it("checks each upload once, through the queue", async () => {
    const photo = await photoWithMetadata();
    const { fileId } = await upload(photo, "image/jpeg");
    const queue = new Queue("files", {
      connection: createRedis(process.env.REDIS_URL as string),
      prefix: queuePrefix("files"),
    });
    await queue.add("process", { meta: {}, payload: { fileId } }, { jobId: fileId });
    await queue.add("process", { meta: {}, payload: { fileId } }, { jobId: fileId });
    const done = await eventually(
      () => row(fileId),
      (found) => found?.status === "ready",
    );
    expect(done?.status).toBe("ready");
    await queue.close();
    // Already checked: nothing happens a second time.
    await files.check(fileId);
    expect((await row(fileId))?.status).toBe("ready");
  });

  it("forgets abandoned uploads and removes deleted files' objects", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const abandoned = await upload(png);
    await asRole("postgres", (client) =>
      client.query("UPDATE files.file SET created_at = now() - interval '2 days' WHERE id = $1", [
        abandoned.fileId,
      ]),
    );
    const kept = await upload(png);
    await files.check(kept.fileId);
    expect(await storage.head(`files/${kept.fileId}`)).toMatchObject({ contentType: "image/webp" });

    // The user is deleted: the database queues their files' objects for removal.
    await asRole("postgres", (client) =>
      client.query(`DELETE FROM auth."user" WHERE id = $1`, [kept.userId]),
    );
    await maintenance.run("files-cleanup");
    expect(await row(abandoned.fileId)).toBeUndefined();
    expect(await storage.head(`quarantine/${abandoned.fileId}`)).toBeNull();
    expect(await storage.head(`files/${kept.fileId}`)).toBeNull();
    expect(
      await asRole("postgres", async (client) => {
        const { rows } = await client.query(
          "SELECT key FROM files.object_deletion WHERE key LIKE ANY($1)",
          [[`%${abandoned.fileId}`, `%${kept.fileId}`]],
        );
        return rows;
      }),
    ).toEqual([]);
  });

  it("forgets an upload whose row is gone, and refuses to check files when they're off", async () => {
    await files.check(fileIdSchema.parse(randomUUID()));
    const { FilesProcessor } = await import("../src/files/files.processor");
    const redis = createRedis(process.env.REDIS_URL as string);
    const off = new FilesProcessor(
      app.get<Database>(DATABASE),
      null,
      { scan: async () => ({ clean: true }) },
      redis,
      { info: () => undefined, warn: () => undefined } as unknown as PinoLogger,
    );
    await expect(off.check(fileIdSchema.parse(randomUUID()))).rejects.toThrow(/files are off/);
    await redis.quit();
  });

  it("leaves an upload for the job's retry when the virus scan can't run", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const { fileId } = await upload(png);
    const { FilesProcessor } = await import("../src/files/files.processor");
    const redis = createRedis(process.env.REDIS_URL as string);
    const clamdDown = new FilesProcessor(
      app.get<Database>(DATABASE),
      storage,
      {
        scan: async () => {
          throw new Error("clamd: connection refused");
        },
      },
      redis,
      { info: () => undefined, warn: () => undefined } as unknown as PinoLogger,
    );
    await expect(clamdDown.check(fileId)).rejects.toThrow("clamd: connection refused");
    await redis.quit();
    expect(await row(fileId)).toMatchObject({ status: "processing", reject_reason: null });
    expect(await storage.head(`quarantine/${fileId}`)).toEqual({
      size: png.length,
      contentType: "image/png",
    });
  });

  it("rejects an upload whose object never arrived, or is over the limit", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const missing = await upload(png);
    await storage.delete(`quarantine/${missing.fileId}`);
    await files.check(missing.fileId);
    expect(await row(missing.fileId)).toMatchObject({
      status: "rejected",
      reject_reason: "FILE_UNREADABLE",
    });
    const huge = Buffer.alloc(5_000_001, 1);
    const tooLarge = await upload(huge, "image/png");
    await files.check(tooLarge.fileId);
    expect(await row(tooLarge.fileId)).toMatchObject({
      status: "rejected",
      reject_reason: "FILE_TOO_LARGE",
    });
    expect(await storage.head(`quarantine/${tooLarge.fileId}`)).toBeNull();
  });

  it("only the uploader and the worker see a pending upload", async () => {
    const { userId, fileId } = await upload(Buffer.from("x"));
    const seenBy = async (viewer: string) =>
      asRole("app_api", async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.user_id', $1, true)", [viewer]);
        const { rows } = await client.query("SELECT id FROM files.file WHERE id = $1", [fileId]);
        await client.query("COMMIT");
        return rows.length;
      });
    expect(await seenBy(userId)).toBe(1);
    expect(await seenBy(randomUUID())).toBe(0);
    await expect(
      asRole("app_worker", (client) =>
        client.query("UPDATE files.file SET purpose = 'x' WHERE id = $1", [fileId]),
      ),
    ).rejects.toThrow(/permission denied/);
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
