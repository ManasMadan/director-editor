/**
 * Lints the database migrations a change adds or edits with Squawk (.squawk.toml):
 * `bun run db:lint`. Compares with master (or $GITHUB_BASE_REF in a pull request);
 * migrations already on master are applied everywhere and can't change anyway. Given
 * files instead (the pre-commit hook passes the staged ones), it lints those.
 */
import { ok, ROOT, runMain, runSync } from "./lib";

// renovate: datasource=npm depName=squawk-cli
const SQUAWK = "squawk-cli@2.66.0";

/** Lints the migrations in `given`, else those changed since the base; the exit code. */
export function lintMigrations(
  given = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  run = runSync,
): number {
  const base = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : "master";
  const diff = run(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=AM",
      `${base}...HEAD`,
      "--",
      "packages/db/prisma/migrations",
    ],
    { cwd: ROOT },
  );
  if (diff.status !== 0) {
    console.error(diff.stderr);
    return 1;
  }
  const changed = (given.length ? given : diff.stdout.split("\n")).filter((file) =>
    file.endsWith("/migration.sql"),
  );
  if (changed.length === 0) {
    ok(`no new migrations since ${base}`);
    return 0;
  }
  return run("bunx", [SQUAWK, ...changed], { cwd: ROOT, stdio: "inherit" }).status ?? 1;
}

await runMain(import.meta, lintMigrations);
