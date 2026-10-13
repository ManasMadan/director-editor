/**
 * Every lint step, `bun run lint`: formatting and lint (Biome), architecture boundaries,
 * unused code (knip), shortcut markers, ruled-out code patterns, suppressions, the Prisma
 * schema's formatting, the
 * linters that don't come from npm (scripts/linters.ts), and each package's own lint
 * (turbo). All of them run even when one fails, so one failure never
 * hides another's results; it exits non-zero at the end if any failed. CI's lint job runs
 * the same command.
 */
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

/** The steps, in order, each a `bun run` script or a command. */
export const STEPS: string[][] = [
  ["bunx", "biome", "check", "."],
  ["bun", "run", "lint:boundaries"],
  ["bun", "run", "lint:unused"],
  ["bun", "run", "lint:markers"],
  ["bun", "run", "lint:patterns"],
  ["bun", "run", "lint:suppressions"],
  ["bun", "run", "lint:prisma"],
  ["bun", "run", "lint:actionlint"],
  ["bun", "run", "lint:zizmor"],
  ["bun", "run", "lint:shellcheck"],
  ["bun", "run", "lint:hadolint"],
  ["bun", "run", "lint:tflint"],
  ["bun", "run", "lint:renovate"],
  ["bunx", "turbo", "run", "lint"],
];

/** Runs every step (the runner returns its exit code) and returns the ones that failed. */
export function runAll(steps: string[][], run: (step: string[]) => number): string[][] {
  return steps.filter((step) => run(step) !== 0);
}

/** The command: every step, then which passed; the exit code. */
export function main(run: Run = runSync): number {
  const failed = runAll(STEPS, ([command = "", ...args]) => {
    return run(command, args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
  });
  for (const step of STEPS) {
    if (failed.includes(step)) {
      fail(step.join(" "));
    } else {
      ok(step.join(" "));
    }
  }
  return failed.length ? 1 : 0;
}

await runMain(import.meta, main);
