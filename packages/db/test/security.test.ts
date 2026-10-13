/**
 * Proves the database enforces tenancy and least privilege by itself, independent of
 * application code: run as the real service roles against a fresh migrated database.
 */
import { randomUUID } from "node:crypto";
import { type OrgId, orgIdSchema, type UserId, userIdSchema } from "@repo/contracts/ids";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createDb, type Db, tenantTx, type userTx, withTenant, withUser } from "../src";
import { createTestDatabase, type TestDatabase } from "../src/testing";

let testDb: TestDatabase;
let api: Db;
const orgA = orgIdSchema.parse(randomUUID());
const orgB = orgIdSchema.parse(randomUUID());
const userId = userIdSchema.parse(randomUUID());

async function asRole<T>(role: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDb.urlFor(role) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  api = createDb({ url: testDb.urlFor("app_api"), poolMax: 5, service: "test" });
  // Tenant rows reference real organizations and users (foreign keys).
  await api.user.create({ data: { id: userId, name: "Owner", email: `${userId}@test.dev` } });
  for (const id of [orgA, orgB]) {
    await api.organization.create({ data: { id, name: id, slug: id } });
  }
  await tenantTx(api, orgA, (tx) =>
    tx.todo.create({ data: { orgId: orgA, createdById: userId, title: "A1" } }),
  );
  await tenantTx(api, orgB, (tx) =>
    tx.todo.create({ data: { orgId: orgB, createdById: userId, title: "B1" } }),
  );
});

afterAll(async () => {
  await api?.$disconnect();
  await testDb?.drop();
});

describe("row-level security", () => {
  it("scopes by a workspace's or a user's id, never a plain string or the other kind", () => {
    // Checked by the type checker: a user's id passed as the tenant doesn't compile.
    expectTypeOf<Parameters<typeof withTenant>[1]>().toEqualTypeOf<OrgId>();
    expectTypeOf<Parameters<typeof tenantTx>[1]>().toEqualTypeOf<OrgId>();
    expectTypeOf<Parameters<typeof withUser>[1]>().toEqualTypeOf<UserId>();
    expectTypeOf<Parameters<typeof userTx>[1]>().toEqualTypeOf<UserId>();
    expectTypeOf<UserId>().not.toExtend<Parameters<typeof withTenant>[1]>();
    expectTypeOf<OrgId>().not.toExtend<Parameters<typeof withUser>[1]>();
    expectTypeOf<string>().not.toExtend<Parameters<typeof tenantTx>[1]>();
  });

  it("shows a tenant only its own rows", async () => {
    const rows = await withTenant(api, orgA).todo.findMany();
    expect(rows.map((row) => row.title)).toEqual(["A1"]);
  });

  it("shows nothing when no tenant is set", async () => {
    expect(await api.todo.count()).toBe(0);
  });

  it("rejects writing a row into another tenant", async () => {
    await expect(
      withTenant(api, orgA).todo.create({
        data: { orgId: orgB, createdById: userId, title: "sneaky" },
      }),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const tenant = withTenant(api, orgA);
    expect(
      (await tenant.todo.updateMany({ where: { orgId: orgB }, data: { completed: true } })).count,
    ).toBe(0);
    expect((await tenant.todo.deleteMany({ where: { orgId: orgB } })).count).toBe(0);
  });

  it("blocks nested transactions on a tenant client, which would not be atomic", () => {
    const tenant = withTenant(api, orgA);
    // The type allows no arguments (so real calls don't compile); the runtime also throws.
    expect(() => tenant.$transaction()).toThrow(/tenantTx/);
    expect(() => withUser(api, userId).$transaction()).toThrow(/userTx/);
  });

  it("never leaks across tenants under concurrent pooled requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        const org = i % 2 === 0 ? orgA : orgB;
        return withTenant(api, org)
          .todo.findMany()
          .then((rows) => rows.every((row) => row.orgId === org));
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });

  // Tables with a user_id that are deliberately not row-level secured, and why.
  const UNSCOPED_USER_TABLES: Record<string, string> = {
    "notifications.delivery":
      "the notifications service's own delivery log; no other role reads it",
  };

  it("keeps the policy forced on every tenant and per-user table (drift checks cannot see this)", async () => {
    // Tenant tables (org_id) and per-user tables (user_id) outside auth, which better-auth
    // owns and guards with grants. Partitioned parents count; their partitions inherit.
    const tables = await asRole("migrator", async (client) => {
      const { rows } = await client.query<{ table: string; forced: boolean; policies: number }>(`
        SELECT DISTINCT n.nspname || '.' || c.relname AS table, c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND (col.column_name = 'org_id' OR (col.column_name = 'user_id' AND n.nspname <> 'auth'))
          AND c.relname <> 'outbox_event'`);
      return rows.filter((row) => !(row.table in UNSCOPED_USER_TABLES));
    });
    const names = tables.map((table) => table.table);
    // The shapes this must keep covering: a partitioned table and per-user tables.
    expect(names).toEqual(
      expect.arrayContaining(["audit.audit_log", "files.file", "notifications.device"]),
    );
    for (const table of tables) {
      expect(table, `${table.table} must FORCE row-level security with a policy`).toMatchObject({
        forced: true,
      });
      expect(table.policies, `${table.table} needs a policy`).toBeGreaterThan(0);
    }
  });

  it("scopes per-user tables to the user in app.user_id", async () => {
    const policies = await asRole("migrator", async (client) => {
      const { rows } = await client.query<{ table: string; expr: string }>(`
        SELECT schemaname || '.' || tablename AS table, coalesce(qual, '') || coalesce(with_check, '') AS expr
        FROM pg_policies WHERE schemaname IN ('files', 'notifications')`);
      return rows;
    });
    for (const table of ["files.file", "notifications.device", "notifications.notification"]) {
      const rows = policies.filter((policy) => policy.table === table);
      expect(rows.length, `${table} needs a policy`).toBeGreaterThan(0);
      expect(rows.some((policy) => policy.expr.includes("app.user_id"))).toBe(true);
    }
  });
});

describe("least privilege", () => {
  it("lets notifications read identity columns only", async () => {
    await asRole("app_notifications", async (client) => {
      await expect(
        client.query(`SELECT id, email, locale, timezone FROM auth."user"`),
      ).resolves.toMatchObject({ command: "SELECT" });
      await expect(client.query(`SELECT email_verified FROM auth."user"`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("SELECT * FROM auth.account")).rejects.toThrow(/permission denied/);
      await expect(client.query("SELECT * FROM app.todo")).rejects.toThrow(/permission denied/);
    });
  });

  it("lets the worker only stamp outbox events as published", async () => {
    await asRole("app_worker", async (client) => {
      await expect(
        client.query("UPDATE app.outbox_event SET published_at = now() WHERE false"),
      ).resolves.toMatchObject({ command: "UPDATE", rowCount: 0 });
      await expect(
        client.query("UPDATE app.outbox_event SET payload = '{}' WHERE false"),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM app.outbox_event WHERE false")).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("SELECT * FROM app.todo")).rejects.toThrow(/permission denied/);
    });
  });

  it("denies schema changes to service roles", async () => {
    await asRole("app_api", async (client) => {
      await expect(client.query("CREATE TABLE app.nope (id int)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("ALTER TABLE app.todo DISABLE ROW LEVEL SECURITY")).rejects.toThrow(
        /must be owner/,
      );
    });
  });
});

describe("functions that run as their owner", () => {
  // Only create or drop partitions of the table: they never read its rows.
  const DDL_ONLY = new Set(["audit.ensure_partitions", "audit.drop_partitions_before"]);

  it("see the rows of every forced row-level security table they touch", async () => {
    // FORCE ROW LEVEL SECURITY applies to the owner too, so a SECURITY DEFINER function
    // with no tenant set sees nothing unless the table has a policy for its owner.
    const { functions, tables } = await asRole("postgres", async (client) => ({
      functions: (
        await client.query<{ name: string; owner: string; body: string }>(
          `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner,
                  p.prosrc AS body
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
        )
      ).rows,
      tables: (
        await client.query<{ name: string; roles: string[] }>(
          `SELECT n.nspname || '.' || c.relname AS name,
                  coalesce(array_agg(r.rolname) FILTER (WHERE r.rolname IS NOT NULL), '{}') AS roles
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_policy p ON p.polrelid = c.oid
             LEFT JOIN pg_roles r ON r.oid = ANY (p.polroles)
            WHERE c.relforcerowsecurity
            GROUP BY 1`,
        )
      ).rows,
    }));
    expect(functions.length).toBeGreaterThan(0);
    const blind = functions
      .filter((fn) => !DDL_ONLY.has(fn.name))
      .flatMap((fn) =>
        tables
          .filter((table) => new RegExp(`\\b${table.name.replace(".", "\\.")}\\b`).test(fn.body))
          .filter((table) => !table.roles.includes(fn.owner))
          .map((table) => `${fn.name} → ${table.name} (no policy for ${fn.owner})`),
      );
    expect(blind).toEqual([]);
  });
});
