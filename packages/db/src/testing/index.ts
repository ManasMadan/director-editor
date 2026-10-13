/**
 * Isolated databases for integration tests.
 *
 *   // vitest globalSetup: migrate the template once per run
 *   await prepareTemplate();
 *   // each test file: its own copy, created in milliseconds from the template
 *   const testDb = await createTestDatabase();
 *   const db = createDb({ url: testDb.urlFor("app_api"), poolMax: 5, service: "test" });
 *   ...
 *   await testDb.drop();
 *
 * Tests connect as the same least-privileged roles the services use, so missing grants
 * and row-level-security mistakes fail in tests, not in production.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldOf } from "@repo/contracts/objects";
import pg from "pg";

export { factories } from "./factories";

const DB_PACKAGE = join(import.meta.dirname, "../..");
const TEMPLATE = "app_test";
/**
 * Advisory lock guarding the template: preparing it takes it exclusively, cloning it
 * shared, so test runs of several packages at once never clone mid-migration.
 */
const TEMPLATE_LOCK = 482_117_001;

/**
 * How long a test database's drop waits for the services' connections to close: longer
 * than node-postgres's 10-second idle timeout, since a query that lands after an app has
 * closed (a background task finishing) reopens one connection that then idles that long.
 */
const BACKENDS_GONE_MS = 15_000;

/** Local role passwords match the role names (infra/postgres/init). */
const ROLE_PASSWORDS: Record<string, string> = {
  migrator: "migrator",
  app_api: "app_api",
  app_worker: "app_worker",
  app_notifications: "app_notifications",
  app_webhooks: "app_webhooks",
  app_ai: "app_ai",
};
const SERVICE_ROLES = Object.keys(ROLE_PASSWORDS).filter((role) => role !== "migrator");

function serverUrl() {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) {
    throw new Error("MIGRATOR_DATABASE_URL must be set for integration tests (see .env.example).");
  }
  return new URL(url);
}

function urlFor(database: string, role: string) {
  const url = serverUrl();
  url.username = role;
  url.password = ROLE_PASSWORDS[role] ?? role;
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Applies all migrations to the template database (`app_test`, or the one named). Call
 * once per test run; concurrent runs (several packages under turbo) take turns on an
 * advisory lock.
 *
 * If a migration recorded in the template no longer matches its file (it was edited
 * before shipping, or removed), the template's schemas are rebuilt from scratch: deploy
 * alone would keep the old version. Extensions (created by a superuser at bootstrap)
 * live in `public` and stay.
 */
export async function prepareTemplate(template = TEMPLATE) {
  // The lock is held from the maintenance database: Postgres refuses to clone a database
  // anyone is connected to, so nothing but the work below may touch the template.
  const lock = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    await dropAbandonedTestDatabases();
    const client = new pg.Client({ connectionString: urlFor(template, "migrator") });
    await client.connect();
    try {
      if (await isStale(client)) {
        const { rows } = await client.query<{ nspname: string }>(
          "SELECT nspname FROM pg_namespace WHERE nspowner = 'migrator'::regrole",
        );
        for (const { nspname } of rows) {
          await client.query(`DROP SCHEMA ${pg.escapeIdentifier(nspname)} CASCADE`);
        }
        await client.query("DROP TABLE IF EXISTS public._prisma_migrations");
      }
    } finally {
      await client.end();
    }
    execFileSync("bunx", ["prisma", "migrate", "deploy"], {
      cwd: DB_PACKAGE,
      env: { ...process.env, MIGRATOR_DATABASE_URL: urlFor(template, "migrator") },
      stdio: "pipe",
    });
  } finally {
    // Ending the session releases the lock, after every connection to the template closed.
    await lock.end();
  }
}

async function isStale(client: pg.Client) {
  const table = await client.query<{ t: string | null }>(
    "SELECT to_regclass('public._prisma_migrations') AS t",
  );
  if (!table.rows[0]?.t) {
    return false;
  }
  const { rows } = await client.query<{ migration_name: string; checksum: string }>(
    "SELECT migration_name, checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL",
  );
  return rows.some(({ migration_name, checksum }) => {
    const file = join(DB_PACKAGE, "prisma/migrations", migration_name, "migration.sql");
    return (
      !existsSync(file) ||
      createHash("sha256").update(readFileSync(file)).digest("hex") !== checksum
    );
  });
}

/** Test database names carry the pid of the process that owns them (and drops them). */
const TEST_DATABASE = /^app_test_(\d+)_[0-9a-f]+$/;

/** Whether process `pid` runs on this machine (as any user). */
export function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return fieldOf(error, "code") === "EPERM";
  }
}

/**
 * Drops the test databases of runs that died before their files' `drop()` (killed,
 * crashed, out of memory): the process in their name no longer runs. Test databases
 * live on the local server only, so the pid is on this machine.
 */
export async function dropAbandonedTestDatabases(
  abandoned = (_name: string, pid: number) => !isRunning(pid),
) {
  const client = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'app\\_test\\_%'",
    );
    for (const { datname } of rows) {
      const pid = TEST_DATABASE.exec(datname)?.[1];
      if (pid !== undefined && abandoned(datname, Number(pid))) {
        await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`);
      }
    }
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  urlFor(role: string): string;
  /** Drops it, once the services' connections are gone (waiting up to `waitMs` for them). */
  drop(waitMs?: number): Promise<void>;
}

/** Clones the migrated template into a fresh database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `app_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock_shared($1)", [TEMPLATE_LOCK]);
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
    await admin.query("SELECT pg_advisory_unlock_shared($1)", [TEMPLATE_LOCK]);
    // Database-level privileges are not copied from the template.
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${SERVICE_ROLES.join(", ")}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    urlFor: (role) => urlFor(name, role),
    async drop(waitMs = BACKENDS_GONE_MS) {
      const client = new pg.Client({ connectionString: urlFor("postgres", "migrator") });
      await client.connect();
      try {
        // FORCE can only end the migrator's own sessions, and a client's disconnect ends
        // its server backend a moment later (or a pool opens another): try again until
        // the services' sessions are gone. A drop that fails changes nothing.
        const deadline = Date.now() + waitMs;
        for (;;) {
          try {
            await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            break;
          } catch (error) {
            if (Date.now() >= deadline) {
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      } catch (error) {
        // FORCE can only end the migrator's own sessions, so a connection a test left open
        // as another role fails the drop: name it, it's a leak in the test or the service.
        // The migrator sees other roles' sessions but not what they run: name who holds them.
        const { rows } = await client.query<{
          usename: string;
          application_name: string;
          pid: number;
        }>("SELECT usename, application_name, pid FROM pg_stat_activity WHERE datname = $1", [
          name,
        ]);
        const open = rows
          .map(
            (row) =>
              `${row.usename} (pid ${row.pid}${row.application_name ? `, ${row.application_name}` : ""})`,
          )
          .join(", ");
        throw new Error(`Couldn't drop ${name}; connections still open: ${open}`, { cause: error });
      } finally {
        await client.end();
      }
    },
  };
}
