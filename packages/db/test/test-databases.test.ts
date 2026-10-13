/** Test databases left behind by a run that died are dropped by the next run. */
import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, dropAbandonedTestDatabases, isRunning } from "../src/testing";

const admin = () => {
  const url = new URL(process.env.MIGRATOR_DATABASE_URL ?? "");
  url.pathname = "/postgres";
  return new pg.Client({ connectionString: url.toString() });
};
let client: pg.Client;
const exists = async (name: string) =>
  (await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1;

beforeAll(async () => {
  client = admin();
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe("abandoned test databases", () => {
  it("tell a process that's gone from one that runs, as this user or another", () => {
    expect(isRunning(process.pid)).toBe(true);
    // The pid of a process that has exited.
    expect(isRunning(spawnSync("true").pid ?? 0)).toBe(false);
    // init/launchd: running, as root, so signalling it is refused (EPERM).
    expect(isRunning(1)).toBe(true);
  });

  it("are dropped once their process is gone; a running process's stay", async () => {
    // Named for this process, so other packages' runs (which drop abandoned databases
    // as they start, in parallel on CI) leave it alone; this call treats it as abandoned.
    const abandoned = `app_test_${process.pid}_0123456789ab`;
    await client.query(`CREATE DATABASE ${abandoned}`);
    const live = await createTestDatabase();
    try {
      await dropAbandonedTestDatabases((name) => name === abandoned);
      // By default only a gone process's databases go: this run's own stays.
      await dropAbandonedTestDatabases();
      expect(await exists(abandoned)).toBe(false);
      expect(await exists(live.name)).toBe(true);
      expect(await exists("app_test")).toBe(true);
    } finally {
      await live.drop();
      await client.query(`DROP DATABASE IF EXISTS ${abandoned}`);
    }
  });
});

describe("dropping a test database", () => {
  it("waits for a service's connection that's closing", async () => {
    const testDb = await createTestDatabase();
    const service = new pg.Client({ connectionString: testDb.urlFor("app_api") });
    await service.connect();
    // FORCE can't end another role's session: the drop's first attempt fails while it's
    // open (a session's last statement stays in pg_stat_activity), and it keeps trying
    // until the connection is gone.
    const dropping = testDb.drop();
    await vi.waitFor(async () => {
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = $1",
        [`DROP DATABASE IF EXISTS ${testDb.name} WITH (FORCE)`],
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
    });
    expect(await exists(testDb.name)).toBe(true);
    await service.end();
    await dropping;
    expect(await exists(testDb.name)).toBe(false);
  });

  it("names a connection a test left open", async () => {
    const testDb = await createTestDatabase();
    const leak = new pg.Client({ connectionString: testDb.urlFor("app_api") });
    const named = new pg.Client({
      connectionString: testDb.urlFor("app_worker"),
      application_name: "leaky-service",
    });
    await Promise.all([leak.connect(), named.connect()]);
    try {
      const drop = testDb.drop(200);
      await expect(drop).rejects.toThrow(/connections still open: .*app_api \(pid \d+\)/);
      await expect(drop).rejects.toThrow(/app_worker \(pid \d+, leaky-service\)/);
    } finally {
      await Promise.all([leak.end(), named.end()]);
      await testDb.drop();
    }
  });
});
