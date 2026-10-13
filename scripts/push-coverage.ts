/**
 * Before a push leaves the machine: every file it can affect at 100%, across every suite,
 * as CI checks on the pull request. The packages its commits change and every package
 * that depends on them (turbo's `...[base]`) run their whole coverage suite (unit,
 * integration, browser, mobile, Python), Bun's runs for the repo's tooling (the scripts,
 * the hooks and the rest it owns), and scripts/coverage.ts checks each of those files.
 *
 *   bun scripts/push-coverage.ts                   two suites at a time
 *   bun scripts/push-coverage.ts --concurrency=4   (the pre-push hook sizes it to the machine)
 *
 * Then, as CI's coverage job does on a pull request, diff-cover over the merged report:
 * every line the push adds or changes is covered.
 *
 * It needs Docker: it starts the core services and RustFS. ClamAV comes from the
 * stand-in in @repo/testing/fake-clamd unless it's running. A push that changes shared
 * code (contracts, nest-common) runs most suites, so it takes a while; one that changes a
 * single app runs that app's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";
import { pushBase } from "./unit-coverage";

const turboList = z.object({
  packages: z.object({ items: z.array(z.object({ path: z.string() })) }),
});

/** The folders of the packages a push from `base` changes, and of everything depending on them. */
export function affected(base: string, run: Run, root = ROOT): string[] {
  const listed = run("bunx", ["turbo", "ls", `--filter=...[${base}]`, "--output=json"], {
    cwd: root,
  });
  if (listed.status !== 0) {
    throw new Error(`turbo ls failed: ${listed.stderr.trim()}`);
  }
  return turboList.parse(JSON.parse(listed.stdout)).packages.items.map((item) => item.path);
}

/** Starts what the suites need; false when Docker isn't running. */
function services(run: Run, root: string) {
  if (run("docker", ["info"], { cwd: root }).status !== 0) {
    fail("Docker isn't running: start it, since the push runs every suite of what it changes.");
    return false;
  }
  const inherit = { cwd: root, stdio: "inherit" } as const;
  return (
    run("bun", ["scripts/services.ts", "up"], inherit).status === 0 &&
    run("docker", ["compose", "--profile", "files", "up", "-d", "--wait", "rustfs"], inherit)
      .status === 0
  );
}

/** diff-cover at the version CI's coverage job runs. */
export function diffCover(root = ROOT) {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const pinned = /uvx (diff-cover@\S+)/.exec(ci)?.[1];
  if (!pinned) {
    throw new Error("ci.yml no longer runs `uvx diff-cover@<version>`: update push-coverage.ts");
  }
  return pinned;
}

/** The check; the exit code. */
export function pushCoverage({
  run = runSync,
  root = ROOT,
  argv = process.argv.slice(2),
} = {}): number {
  const concurrency = argv.find((arg) => /^--concurrency=\d+$/.test(arg))?.split("=")[1] ?? "2";
  const base = pushBase((args) => run("git", args, { cwd: root }).stdout);
  const packages = affected(base, run, root);
  const inherit = { cwd: root, stdio: "inherit" } as const;
  if (packages.length > 0) {
    if (!services(run, root)) {
      return 1;
    }
    // A few at a time (two by default): the integration suites share the services, and a
    // busy machine makes timing-sensitive tests flaky.
    const suites = run(
      "bunx",
      ["turbo", "run", "coverage", `--filter=...[${base}]`, `--concurrency=${concurrency}`],
      inherit,
    );
    if (suites.status !== 0) {
      fail("tests failed");
      return 1;
    }
  }
  const scripts = run("bun", ["test", "--coverage", "./scripts/", "./.claude/hooks/"], inherit);
  if (scripts.status !== 0) {
    fail("the scripts' or hooks' tests failed, or left a file below 100%");
    return 1;
  }
  const checked = run("bun", ["scripts/coverage.ts", ...packages, "--bun"], inherit);
  if (checked.status !== 0) {
    return 1;
  }
  const lines =
    packages.length === 0 ||
    run(
      "uvx",
      [diffCover(root), "coverage/merged.lcov", "--compare-branch", base, "--fail-under", "100"],
      inherit,
    ).status === 0;
  if (!lines) {
    fail("a line the push adds or changes isn't covered (diff-cover above)");
    return 1;
  }
  ok(`every file in ${packages.length} package(s) and the repo's tooling at 100%`);
  return 0;
}

await runMain(import.meta, pushCoverage);
