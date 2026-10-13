/**
 * Formats the staged OpenTofu files (the pre-commit hook). OpenTofu is only needed for
 * infrastructure work, so without it the commit goes on with a warning: CI's infra job
 * checks the formatting either way.
 */
import { ROOT, runMain, runSync, warn } from "./lib";

/** `tofu fmt` on `files` when OpenTofu is installed; the exit code. */
export function tofuFmt(files = process.argv.slice(2), run = runSync): number {
  if (run("tofu", ["version"], { cwd: ROOT, stdio: "ignore" }).status !== 0) {
    warn("OpenTofu isn't installed, so `tofu fmt` was skipped (CI checks the formatting).");
    return 0;
  }
  return run("tofu", ["fmt", ...files], { cwd: ROOT, stdio: "inherit" }).status ?? 1;
}

await runMain(import.meta, tofuFmt);
