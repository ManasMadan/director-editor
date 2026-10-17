/**
 * Reinstalls the dependencies when git moves the checkout to a commit whose bun.lock
 * differs: the post-merge, post-checkout and post-rewrite hooks run it. Without it a pull
 * or branch switch that adds a dependency leaves node_modules behind the lockfile, and
 * the code fails at runtime on a package that resolves to some other, older copy.
 *
 *   bun scripts/sync-install.ts <old revision> <new revision>
 *
 * A git hook can't undo what already happened, so this never fails the hook: when the
 * install fails it says so and how to run it by hand.
 */
import { ROOT, runMain, runSync, warn } from "./lib";

/** A revision git uses for "nothing" (the old side of a fresh clone or a new worktree). */
const NO_REVISION = /^0+$/;

/** Runs `bun install --frozen-lockfile` when bun.lock differs between `from` and `to`. */
export function syncInstall([from, to] = process.argv.slice(2), run = runSync): number {
  if (!from || !to || NO_REVISION.test(from) || from === to) {
    return 0;
  }
  // Exit 1 means the lockfile differs; anything else (an unknown revision) installs
  // nothing, since there's no telling what changed.
  const diff = run("git", ["diff", "--quiet", from, to, "--", "bun.lock"], { cwd: ROOT });
  if (diff.status !== 1) {
    return 0;
  }
  console.log("bun.lock changed: installing the dependencies it lists.");
  const install = run("bun", ["install", "--frozen-lockfile"], { cwd: ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    warn("The install failed, so node_modules is behind bun.lock: run `bun install`.");
  }
  return 0;
}

await runMain(import.meta, syncInstall);
