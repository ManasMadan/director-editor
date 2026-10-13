/**
 * Keeps the code generators honest (turbo/generators): runs each one, then everything a
 * pull request must pass on what they wrote: lint (Biome, dependency rules, knip), types,
 * the unit tests, and the generated feature's own integration tests.
 *
 *   bun scripts/generators.ts              in a scratch worktree of this checkout
 *   bun scripts/generators.ts --in-place   here (CI, whose checkout is thrown away)
 *
 * The integration tests need the local services (`bun run db:up`) and a migrated database.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

/** An api feature over the todo table, and a package: names nothing else uses. */
const FEATURE_NAME = "smoke-notes";
const FEATURE = [FEATURE_NAME, "smoke-note", "todo", '{"title":"Smoke"}'];
const PACKAGE = ["smoke-kit", "A package the generators check makes."];

/** Runs a command that must pass, and returns its output; throws when it fails. */
function must(run: Run, cwd: string, [command = "", ...args]: string[]) {
  const result = run(command, args, { cwd });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

/** A copy of this checkout, uncommitted and untracked files included, with its own install. */
function scratch(run: Run) {
  const dir = mkdtempSync(join(tmpdir(), "generators-"));
  must(run, ROOT, ["git", "worktree", "add", "--detach", "--quiet", dir, "HEAD"]);
  const files = must(run, ROOT, ["git", "ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    try {
      cpSync(join(ROOT, file), join(dir, file), { force: true });
    } catch {
      // Deleted in the working tree but still in the index: nothing to copy.
    }
  }
  ok(`scratch copy in ${dir}`);
  must(run, dir, ["bun", "install", "--frozen-lockfile"]);
  return {
    dir,
    remove: () => {
      run("git", ["worktree", "remove", "--force", dir], { cwd: ROOT });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs one check, in `cwd`; whether it passed (its output is shown when it didn't). */
function step(run: Run, label: string, cwd: string, [command = "", ...args]: string[]) {
  const result = run(command, args, { cwd });
  const output = `${result.stdout}${result.stderr}`;
  // turbo gen exits 0 when one of the generator's actions fails; its output says so. And
  // vitest exits 0 when a name filter matches nothing, so a test step must pass something.
  const failedGenerator = /Failed to run|>>> Error/.test(output);
  const ranNothing =
    label.includes("tests") && !/Tests\s+\d+ passed/.test(stripVTControlCharacters(output));
  if (result.status !== 0 || failedGenerator || ranNothing) {
    fail(label);
    console.error(output.trim().split("\n").slice(-60).join("\n"));
    return false;
  }
  ok(label);
  return true;
}

function check(run: Run, dir: string) {
  const api = join(dir, "apps/api");
  const steps: [string, string, string[]][] = [
    ["generate an api feature", dir, ["bunx", "turbo", "gen", "api-feature", "--args", ...FEATURE]],
    ["generate a package", dir, ["bunx", "turbo", "gen", "package", "--args", ...PACKAGE]],
    ["lint", dir, ["bun", "run", "lint"]],
    ["types", dir, ["bun", "run", "check-types"]],
    ["unit tests", dir, ["bun", "run", "test"]],
    [
      "the feature's integration tests",
      api,
      [
        "bunx",
        "vitest",
        "run",
        "--project",
        "integration",
        "test/api.integration.test.ts",
        "-t",
        FEATURE_NAME,
      ],
    ],
  ];
  return steps.every(([label, cwd, command]) => step(run, label, cwd, command));
}

/** Runs both generators and every check on what they wrote; the exit code. */
export function generators(argv = process.argv.slice(2), run = runSync): number {
  const copy = argv.includes("--in-place") ? undefined : scratch(run);
  let passed = false;
  try {
    passed = check(run, copy?.dir ?? ROOT);
  } finally {
    copy?.remove();
  }
  if (!passed) {
    return 1;
  }
  ok("both generators write code that passes lint, types and its tests");
  return 0;
}

await runMain(import.meta, generators);
