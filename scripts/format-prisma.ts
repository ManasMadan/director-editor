/**
 * Formats the Prisma schema: the pre-commit hook, for staged .prisma files. With
 * `--check` (`bun run lint:prisma`, part of `bun run lint`) it only checks, and fails on
 * a file `prisma format` would change, so a commit made without the hook fails CI.
 * Prisma formats the schema folder as a whole, from its package, whatever files it's given.
 */
import { join } from "node:path";
import { ROOT, runMain, runSync } from "./lib";

/** Formats the schema, or checks it with `--check`; Prisma's exit code. */
export function formatPrisma(argv = process.argv.slice(2), run = runSync): number {
  const check = argv.includes("--check") ? ["--check"] : [];
  return (
    run("bunx", ["prisma", "format", ...check], {
      cwd: join(ROOT, "packages/db"),
      stdio: "inherit",
    }).status ?? 1
  );
}

await runMain(import.meta, formatPrisma);
