/**
 * Restore drill: `bun run db:restore-drill`. Proves a backup of the database can actually
 * be restored, not just taken. It dumps the database the way logical backups are taken
 * (pg_dump, custom format), restores the dump into a scratch database and requires it to
 * match the source exactly: every table's rows (count and a content hash), row-level
 * security (enabled, forced, every policy), each role's grants, default privileges,
 * functions, triggers, extensions and sequence positions. Then the scratch database and
 * the dump are removed, whatever the outcome.
 *
 *   bun run db:restore-drill                 the local database (compose "postgres")
 *   PG_CONTAINER=<name> bun run db:restore-drill      Postgres in another container (CI)
 *   bun run db:restore-drill <database>      another database than "app"
 *
 * Everything runs inside the Postgres container as its superuser, so no client tools are
 * needed, their version always matches the server, and row-level security doesn't hide
 * rows from the comparison. Roles and database-level grants (owner, CONNECT) are
 * cluster-wide and never part of a dump: a restore into a new cluster creates them first
 * (infra/postgres/init locally, the data chart's managed roles in Kubernetes).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, runMain, runSync } from "./lib";

// One line per fact about the database (rows and their hash per table, security, grants,
// functions, sequences), shared with the data chart's drill of the cluster backups.
const FINGERPRINT = readFileSync(join(ROOT, "deploy/charts/data/files/fingerprint.sql"), "utf8");

/** Whether the restore's fingerprint matches the source's; prints what differs. */
function identical(before: string[], after: string[]) {
  const restored = new Set(after);
  const kept = new Set(before);
  const lost = before.filter((line) => !restored.has(line));
  const extra = after.filter((line) => !kept.has(line));
  if (lost.length === 0 && extra.length === 0) {
    const tables = before.filter((line) => line.startsWith("table ")).length;
    ok(`identical: ${tables} tables with their rows, security, grants and functions`);
    return true;
  }
  fail("the restore differs from the source");
  for (const line of lost) {
    console.log(`    - ${line}`);
  }
  for (const line of extra) {
    console.log(`    + ${line}`);
  }
  return false;
}

/** Dumps `source`, restores it into a scratch database and compares them; the exit code. */
export function restoreDrill(
  source = process.argv[2] ?? "app",
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a script turbo never runs, so turbo.json has no task to declare it on
  container = process.env.PG_CONTAINER,
  run = runSync,
): number {
  const scratch = `${source}_restore_drill`;
  const dump = `/tmp/${scratch}.dump`;
  const exec = container ? ["exec", "-i", container] : ["compose", "exec", "-T", "postgres"];

  function pg(command: string[]) {
    const result = run("docker", [...exec, ...command], { cwd: ROOT });
    if (result.status !== 0) {
      throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  const fingerprint = (database: string) =>
    pg([
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      FINGERPRINT,
    ])
      .split("\n")
      .filter(Boolean);

  function cleanUp() {
    pg(["dropdb", "-U", "postgres", "--if-exists", "--force", scratch]);
    pg(["rm", "-f", dump]);
  }

  let passed = false;
  try {
    cleanUp();
    const before = fingerprint(source);
    pg(["pg_dump", "-U", "postgres", "-d", source, "--format=custom", "-f", dump]);
    ok(`backed up ${source}`);
    pg(["createdb", "-U", "postgres", "-T", "template0", scratch]);
    pg(["pg_restore", "-U", "postgres", "-d", scratch, "--exit-on-error", dump]);
    ok(`restored it into ${scratch}`);
    passed = identical(before, fingerprint(scratch));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    try {
      cleanUp();
    } catch (error) {
      fail(`couldn't remove ${scratch}: ${error instanceof Error ? error.message : error}`);
      passed = false;
    }
  }
  return passed ? 0 : 1;
}

await runMain(import.meta, restoreDrill);
