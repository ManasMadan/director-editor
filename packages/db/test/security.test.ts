/**
 * Proves the database enforces tenancy and least privilege by itself, independent of
 * application code: run as the real service roles against a fresh migrated database.
 */
import { randomUUID } from "node:crypto";
import { type OrgId, orgIdSchema, type UserId, userIdSchema } from "@repo/contracts/ids";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  createDb,
  type Db,
  enterTenant,
  tenantTx,
  transaction,
  type userTx,
  withTenant,
  withUser,
} from "../src";
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
    tx.shortReaction.create({
      data: { orgId: orgA, userId, videoId: "aaaaaaaaaaa", kind: "like" },
    }),
  );
  await tenantTx(api, orgB, (tx) =>
    tx.shortReaction.create({
      data: { orgId: orgB, userId, videoId: "bbbbbbbbbbb", kind: "like" },
    }),
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
    const rows = await withTenant(api, orgA).shortReaction.findMany();
    expect(rows.map((row) => row.videoId)).toEqual(["aaaaaaaaaaa"]);
  });

  it("shows nothing when no tenant is set", async () => {
    expect(await api.shortReaction.count()).toBe(0);
  });

  it("scopes the rest of a transaction to the workspace it enters", async () => {
    const counts = await transaction(api, async (tx) => {
      const before = await tx.shortReaction.count();
      await enterTenant(tx, orgA);
      return [before, await tx.shortReaction.count()];
    });
    expect(counts).toEqual([0, 1]);
  });

  it("rejects writing a row into another tenant", async () => {
    await expect(
      withTenant(api, orgA).shortReaction.create({
        data: { orgId: orgB, userId, videoId: "ccccccccccc", kind: "save" },
      }),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const tenant = withTenant(api, orgA);
    expect(
      (await tenant.shortReaction.updateMany({ where: { orgId: orgB }, data: { kind: "save" } }))
        .count,
    ).toBe(0);
    expect((await tenant.shortReaction.deleteMany({ where: { orgId: orgB } })).count).toBe(0);
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
          .shortReaction.findMany()
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
    // The shapes this must keep covering: a partitioned table, a tenant table and a
    // per-user one.
    expect(names).toEqual(
      expect.arrayContaining(["audit.audit_log", "app.short_reaction", "files.file"]),
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
        FROM pg_policies WHERE schemaname = 'files'`);
      return rows;
    });
    for (const table of ["files.file"]) {
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
      await expect(client.query("SELECT * FROM app.short_reaction")).rejects.toThrow(
        /permission denied/,
      );
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
      await expect(client.query("SELECT * FROM app.short_reaction")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("lets the AI service into its own schemas only", async () => {
    await asRole("app_ai", async (client) => {
      await expect(client.query(`SELECT id FROM auth."user"`)).rejects.toThrow(/permission denied/);
    });
  });

  it("lets only the AI service ask whether a member has used their index", async () => {
    const asked = "SELECT ai.index_used($1) AS used";
    await asRole("app_ai", async (client) => {
      await expect(client.query(asked, [userId])).resolves.toMatchObject({
        rows: [{ used: false }],
      });
    });
    await asRole("app_api", async (client) => {
      await expect(client.query(asked, [userId])).rejects.toThrow(/permission denied/);
    });
  });

  it("lets the API read Director's cuts and record their publishing, and nothing else", async () => {
    const cutId = await asRole("migrator", async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      const {
        rows: [plan],
      } = await client.query<{ id: string }>(
        `INSERT INTO ai.director_plan (org_id, video_id, source, status, stage, plan, updated_at)
         VALUES ($1, 'Publish_Cut', 'seed', 'ready', 'ready', '{}', now()) RETURNING id`,
        [orgA],
      );
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const {
        rows: [file],
      } = await client.query<{ id: string }>(
        `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size, updated_at)
         VALUES ($1, 'director-cut-video', 'ready', 'cut.mp4', 'video/mp4', 10, now()) RETURNING id`,
        [userId],
      );
      const {
        rows: [cut],
      } = await client.query<{ id: string }>(
        `INSERT INTO ai.director_cut (org_id, plan_id, user_id, title, picks, file_id, duration_ms, updated_at)
         VALUES ($1, $2, $3, 'Mine', '[]', $4, 1000, now()) RETURNING id`,
        [orgA, plan?.id, userId, file?.id],
      );
      await client.query("COMMIT");
      return cut?.id;
    });
    const publish = (orgId: OrgId) =>
      tenantTx(api, orgId, (tx) =>
        tx.directorCut.updateMany({
          where: { id: cutId },
          data: {
            publishStatus: "published",
            youtubeVideoId: "dQw4w9WgXcQ",
            visibility: "private",
          },
        }),
      );
    // Its own workspace's cut, the publish columns and updated_at (Prisma sets it).
    expect(await publish(orgA)).toEqual({ count: 1 });
    // Another workspace's: row-level security shows it nothing to update.
    expect(await publish(orgB)).toEqual({ count: 0 });
    await asRole("app_api", async (client) => {
      await expect(client.query("SELECT id FROM ai.director_cut")).resolves.toMatchObject({
        rowCount: 0,
      });
      for (const change of [
        "title = 'Theirs'",
        "picks = '[]'",
        "file_id = gen_random_uuid()",
        "user_id = gen_random_uuid()",
        "duration_ms = 0",
      ]) {
        await expect(
          client.query(`UPDATE ai.director_cut SET ${change} WHERE false`),
          change,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(client.query("DELETE FROM ai.director_cut WHERE false")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        client.query(
          "INSERT INTO ai.director_cut (org_id, plan_id, user_id, title, picks, file_id, duration_ms, updated_at) SELECT org_id, plan_id, user_id, title, picks, file_id, duration_ms, now() FROM ai.director_cut WHERE false",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query("SELECT id FROM ai.director_plan")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("lets the API copy seeded templates into a workspace, and write no other plan", async () => {
    const seed = (orgId: OrgId) => ({
      orgId,
      videoId: "Seed_Short1",
      source: "seed",
      status: "ready",
      stage: "ready",
      plan: { title: "Seed" },
      model: "seed-model",
      audioStatus: "ready",
      audioKey: "seed-audio/Seed_Short1.m4a",
    });
    const copy = (data: ReturnType<typeof seed>) =>
      tenantTx(api, orgA, (tx) => tx.directorPlan.createMany({ data, skipDuplicates: true }));
    expect(await copy(seed(orgA))).toEqual({ count: 1 });
    // Copying again adds nothing: (org_id, video_id) is unique.
    expect(await copy(seed(orgA))).toEqual({ count: 0 });
    // Only seeds, only into the workspace in app.org_id, and never in anyone's name.
    await expect(copy({ ...seed(orgA), videoId: "User_Short1", source: "user" })).rejects.toThrow(
      /row-level security/,
    );
    await expect(copy(seed(orgB))).rejects.toThrow(/row-level security/);
    // Only finished seeds: one the AI service would take for a plan still to write is refused.
    for (const unfinished of [{ status: "pending" }, { stage: "queued" }]) {
      await expect(copy({ ...seed(orgA), videoId: "Seed_Short3", ...unfinished })).rejects.toThrow(
        /row-level security/,
      );
    }
    await expect(
      tenantTx(api, orgA, (tx) =>
        tx.directorPlan.create({
          data: { ...seed(orgA), videoId: "Seed_Short2", createdBy: userId },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await asRole("app_api", async (client) => {
      await expect(client.query("SELECT id FROM ai.director_plan")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        client.query("UPDATE ai.director_plan SET status = 'ready' WHERE false"),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM ai.director_plan WHERE false")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("denies schema changes to service roles", async () => {
    await asRole("app_api", async (client) => {
      await expect(client.query("CREATE TABLE app.nope (id int)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        client.query("ALTER TABLE app.short_reaction DISABLE ROW LEVEL SECURITY"),
      ).rejects.toThrow(/must be owner/);
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
