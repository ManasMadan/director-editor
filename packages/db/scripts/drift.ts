/**
 * Fails when the migrations, the Prisma schema and the database disagree:
 *
 *   1. migrations → schema: a schema change without a migration (or the reverse);
 *   2. database → schema: a database that isn't at the migrations' state.
 *
 * A few things Prisma can't express live only in migrations (it would "fix" them by
 * dropping them). Those are listed in IGNORED with the reason; any other difference fails.
 *
 * It needs MIGRATOR_DATABASE_URL: without a datasource, `prisma migrate diff
 * --from-config-datasource` prints nothing and exits 0, which would read as "no drift".
 */
import { spawnSync } from "node:child_process";

const IGNORED: { statement: string; why: string }[] = [
  {
    statement: 'DROP INDEX "ai"."chunk_embedding_idx";',
    why: "HNSW index on a pgvector column: Prisma has no vector type or HNSW index.",
  },
];

/** What the check needs of `spawnSync`: a command's status and output, as text. */
type Spawn = (
  command: string,
  args: string[],
  options: { encoding: "utf8" },
) => { status: number | null; stdout: string; stderr: string };

/** The check, with `prisma migrate diff` run through `spawn`; the exit code. */
export function drift(spawn: Spawn = spawnSync): number {
  const diff = (from: readonly string[]) => {
    const result = spawn(
      "bunx",
      ["prisma", "migrate", "diff", ...from, "--to-schema", "prisma/schema", "--script"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      throw new Error("prisma migrate diff failed");
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--") && !line.startsWith("Loaded Prisma"));
  };
  let failed = false;
  for (const [label, from] of [
    ["migrations vs schema", ["--from-migrations", "prisma/migrations"]],
    ["database vs schema", ["--from-config-datasource"]],
  ] as const) {
    const unexpected = diff(from).filter(
      (line) => !IGNORED.some((ignored) => ignored.statement === line),
    );
    if (unexpected.length > 0) {
      failed = true;
      process.stderr.write(`Drift (${label}):\n${unexpected.map((l) => `  ${l}`).join("\n")}\n`);
    }
  }
  if (failed) {
    return 1;
  }
  process.stdout.write("No drift between migrations, schema and database.\n");
  return 0;
}

// Run as `bun run drift`, not when a test imports it.
import.meta.main && process.exit(drift());
