/**
 * The template every test database is cloned from is brought up to date, and rebuilt when
 * a migration it recorded was edited or removed. Run on a clone, not on `app_test`, which
 * other runs are cloning.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, prepareTemplate, type TestDatabase } from "../src/testing";

let template: TestDatabase;

async function asMigrator<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: template.urlFor("migrator") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** The recorded migrations: new ids mean they were applied again from scratch. */
const recorded = () =>
  asMigrator(async (client) => {
    const { rows } = await client.query<{ id: string; migration_name: string }>(
      "SELECT id, migration_name FROM public._prisma_migrations ORDER BY migration_name",
    );
    return rows;
  });

beforeAll(async () => {
  template = await createTestDatabase();
});
afterAll(async () => {
  await template.drop();
});

describe("preparing the template", () => {
  it("leaves an up-to-date template alone and rebuilds a stale one", async () => {
    const applied = await recorded();
    expect(applied.length).toBeGreaterThan(0);
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

    await prepareTemplate(template.name);
    expect(await recorded()).toEqual(applied);

    // A migration that was removed after the template recorded it.
    await asMigrator((client) =>
      client.query(
        `INSERT INTO public._prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, 'gone', '20000101000000_removed', now(), 1)`,
      ),
    );
    await prepareTemplate(template.name);
    const rebuilt = await recorded();
    expect(rebuilt.map((row) => row.migration_name)).toEqual(
      applied.map((row) => row.migration_name),
    );
    expect(ids(rebuilt)).not.toContain(applied[0]?.id);

    // A migration that was edited after the template recorded it.
    await asMigrator((client) =>
      client.query("UPDATE public._prisma_migrations SET checksum = 'edited' WHERE id = $1", [
        rebuilt[0]?.id,
      ]),
    );
    await prepareTemplate(template.name);
    expect(ids(await recorded())).not.toContain(rebuilt[0]?.id);
  }, 180_000);

  it("migrates a template that has none of the migrations yet", async () => {
    const before = await recorded();
    await asMigrator(async (client) => {
      const { rows } = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspowner = 'migrator'::regrole",
      );
      for (const { nspname } of rows) {
        await client.query(`DROP SCHEMA ${pg.escapeIdentifier(nspname)} CASCADE`);
      }
      await client.query("DROP TABLE public._prisma_migrations");
    });
    await prepareTemplate(template.name);
    expect((await recorded()).map((row) => row.migration_name)).toEqual(
      before.map((row) => row.migration_name),
    );
  }, 120_000);
});

describe("without a database server configured", () => {
  it("says which variable to set", async () => {
    vi.stubEnv("MIGRATOR_DATABASE_URL", "");
    try {
      await expect(createTestDatabase()).rejects.toThrow(/MIGRATOR_DATABASE_URL must be set/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
