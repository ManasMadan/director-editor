/**
 * No migration creates a policy a table already has under that name. Postgres refuses it
 * ("policy ... already exists"), and only when the migration runs, which for a new
 * migration first happens in production: 20261018210000_recording was refused there for
 * an owner_functions on files.file that 20261018200000_demo_guests had made. This reads
 * the migrations themselves, in the order they're applied, so it fails at once, with no
 * database. A name is free again after `DROP POLICY` or `ALTER POLICY ... RENAME TO`.
 *
 * It sees statements written out in a file, not ones built at run time (`EXECUTE
 * format('CREATE POLICY ...')` in a DO block): give those names no other migration uses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "../prisma/migrations");

interface Migration {
  name: string;
  sql: string;
}

const IDENTIFIER = String.raw`"?([\w$]+)"?`;
const TABLE = String.raw`((?:"?[\w$]+"?\.)?"?[\w$]+"?)`;
const STATEMENT = new RegExp(
  String.raw`\b(?:(CREATE)\s+POLICY\s+${IDENTIFIER}\s+ON\s+${TABLE}` +
    String.raw`|(DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}\s+ON\s+${TABLE}` +
    String.raw`|(ALTER)\s+POLICY\s+${IDENTIFIER}\s+ON\s+${TABLE}\s+RENAME\s+TO\s+${IDENTIFIER})`,
  "gi",
);

/** A table's name as Postgres resolves it: unquoted, lower case, `public` by default. */
function tableOf(written: string) {
  const name = written.replaceAll('"', "").toLowerCase();
  return name.includes(".") ? name : `public.${name}`;
}

/** The SQL without its comments, so a policy named in prose doesn't count. */
function withoutComments(sql: string) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/** What a policy statement does to the table's names: one created, dropped or renamed. */
type Change = { create?: string; drop?: string };

/** The names a matched statement creates and drops, as `<table>.<name>` keys. */
function changeOf(match: RegExpMatchArray): Change {
  const [, create, created, onCreate, drop, dropped, onDrop, alter, from, onAlter, to] = match;
  const key = (table: string | undefined, name: string | undefined) =>
    table && name ? `${tableOf(table)}.${name.toLowerCase()}` : undefined;
  if (create) {
    return { create: key(onCreate, created) };
  }
  if (drop) {
    return { drop: key(onDrop, dropped) };
  }
  return alter ? { drop: key(onAlter, from), create: key(onAlter, to) } : {};
}

/** Each policy a migration creates that its table already had: `<migration>: <table>.<name>`. */
function policyCollisions(migrations: readonly Migration[]): string[] {
  const existing = new Set<string>();
  const collisions: string[] = [];
  for (const { name, sql } of [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const match of withoutComments(sql).matchAll(STATEMENT)) {
      const change = changeOf(match);
      if (change.drop) {
        existing.delete(change.drop);
      }
      if (change.create && existing.has(change.create)) {
        collisions.push(`${name}: ${change.create}`);
      }
      if (change.create) {
        existing.add(change.create);
      }
    }
  }
  return collisions;
}

function migrations(): Migration[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS, entry.name, "migration.sql"), "utf8"),
    }));
}

describe("policies the migrations create", () => {
  it("never take a name their table already has", () => {
    const all = migrations();
    expect(all.length).toBeGreaterThan(30);
    expect(policyCollisions(all)).toEqual([]);
  });

  it("are caught reusing a name, as the recording migration first did", () => {
    const demo = {
      name: "20261018200000_demo_guests",
      sql: "CREATE POLICY owner_functions ON files.file TO migrator USING (true);",
    };
    const recording = {
      name: "20261018210000_recording",
      sql: `-- CREATE POLICY in a comment is no policy
            CREATE POLICY owner_functions ON "files"."file" FOR DELETE TO migrator USING (true);
            CREATE POLICY owner_functions ON app.recording_session TO migrator USING (true);`,
    };
    expect(policyCollisions([recording, demo])).toEqual([
      "20261018210000_recording: files.file.owner_functions",
    ]);
  });

  it("may reuse a name once it was dropped or renamed, or on another table", () => {
    expect(
      policyCollisions([
        {
          name: "1_a",
          sql: "CREATE POLICY p ON a.t USING (true); CREATE POLICY q ON a.t USING (true);",
        },
        { name: "2_b", sql: "DROP POLICY IF EXISTS p ON a.t; ALTER POLICY q ON a.t RENAME TO r;" },
        {
          name: "3_c",
          sql: "CREATE POLICY p ON a.t USING (true); CREATE POLICY q ON a.t USING (true);",
        },
        {
          name: "4_d",
          sql: "CREATE POLICY p ON a.u USING (true); CREATE POLICY p ON t USING (true);",
        },
      ]),
    ).toEqual([]);
  });
});
