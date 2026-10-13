/**
 * Unit coverage of the lines a change touches, in seconds: runs the unit suites that own
 * the changed files with coverage, and names every changed line, branch and function they
 * leave uncovered (diff-cover's rule, unit tests only). The Stop hook runs it on the
 * working tree, the pre-push hook on the commits the branch adds.
 *
 *   bun scripts/unit-coverage.ts            what the working tree changes (against HEAD)
 *   bun scripts/unit-coverage.ts --branch   what the branch's commits change (since the
 *                                           merge base with the default branch)
 *
 * Only the files unit tests are meant to cover count: the repo's tooling (scripts/, the
 * Claude Code hooks and the rest Bun's runner owns: BUN_OWNS in scripts/coverage.ts, its
 * only suite), and, in a package with no integration suite, a source file with a unit
 * test beside it (`src/x.test.ts` for `src/x.ts`). A package
 * with integration tests (`test:integration`) leans on them, which need Docker, for lines
 * no unit test reaches: CI's diff-cover over every suite merged checks those packages,
 * and every other file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { BUN_OWNS, type FileCoverage, isSource, mergeLcov } from "./coverage";
import { fail, ok, ROOT, runMain } from "./lib";
import { coverageExceptions } from "./suppressions";

/** The line numbers a `@@ -a,b +c,d @@` hunk header adds, or none for another line. */
function hunkLines(line: string): number[] {
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk) {
    return [];
  }
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  return Array.from({ length: count }, (_, index) => start + index);
}

/** Changed line numbers per file, from `git diff -U0` output. */
export function parseDiff(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
    if (file) {
      // A deleted file (`+++ /dev/null`) has no lines left to cover.
      lines = file[1] ? new Set() : undefined;
      if (file[1] && lines) {
        changed.set(file[1], lines);
      }
      continue;
    }
    for (const number of lines ? hunkLines(line) : []) {
      lines?.add(number);
    }
  }
  return changed;
}

export type Git = (args: string[]) => string;
const git: Git = (args) => Bun.spawnSync(["git", ...args], { cwd: ROOT }).stdout.toString();

/**
 * The commit a push starts from: where HEAD meets the branch's upstream, or, for a branch
 * never pushed, the default branch.
 */
export function pushBase(run: Git = git) {
  const upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const head = run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
  return run(["merge-base", "HEAD", upstream.trim() || head || "master"]).trim();
}

/**
 * What changed: the commits a push would send (since the branch's upstream, or, for a
 * branch never pushed, since the merge base with the default branch), or the working
 * tree against HEAD, untracked files counted whole.
 */
export function changedLines(branch: boolean, run = git, root = ROOT) {
  if (branch) {
    const base = pushBase(run);
    return parseDiff(run(["diff", "-U0", "--no-color", "--no-ext-diff", base, "HEAD"]));
  }
  const changed = parseDiff(run(["diff", "-U0", "--no-color", "--no-ext-diff", "HEAD"]));
  for (const file of run(["ls-files", "-o", "--exclude-standard"]).split("\n").filter(Boolean)) {
    const count = readFileSync(join(root, file), "utf8").replace(/\n$/, "").split("\n").length;
    changed.set(file, new Set(Array.from({ length: count }, (_, index) => index + 1)));
  }
  return changed;
}

/** Where Bun's tests are: a change to one runs the suite. */
const BUN_TESTS = /^(scripts|\.claude\/hooks)\//;
const PACKAGE_FILE = /^((?:apps|packages)\/[^/]+)\/src\/.+\.tsx?$/;

/** A unit suite with coverage: where it runs, what it runs, and where its report lands. */
export interface Suite {
  cwd: string;
  command: string[];
  lcov: string;
  owns?: RegExp;
}

/**
 * The package whose unit suite is a vitest run (`"test": "vitest run ..."`) and is its
 * only suite, or null: a package with integration tests, mobile's Jest and the Python
 * service are left to CI.
 */
function vitestPackage(dir: string, root: string) {
  const manifest = join(root, dir, "package.json");
  if (!existsSync(manifest)) {
    return null;
  }
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()).optional() })
    .parse(JSON.parse(readFileSync(manifest, "utf8")));
  if (scripts?.["test:integration"]) {
    return null;
  }
  return scripts?.test?.startsWith("vitest run") ? dir : null;
}

/** Whether unit tests are meant to cover `path` (see the header). */
export function unitCovered(path: string, root = ROOT) {
  if (!isSource(path)) {
    return false;
  }
  if (BUN_OWNS.test(path)) {
    return true;
  }
  const inPackage = PACKAGE_FILE.exec(path);
  const dir = inPackage?.[1];
  if (!dir || !vitestPackage(dir, root)) {
    return false;
  }
  const sibling = path.replace(/\.tsx?$/, "");
  return [".test.ts", ".test.tsx"].some((ext) => existsSync(join(root, `${sibling}${ext}`)));
}

/** The suites to run for `files`: Bun's for the repo's tooling, vitest per package. */
export function suitesFor(files: string[], root = ROOT): Suite[] {
  const suites: Suite[] = [];
  if (files.some((file) => BUN_TESTS.test(file) || (isSource(file) && BUN_OWNS.test(file)))) {
    suites.push({
      cwd: root,
      // Paths, not names: `bun test` treats a bare word as a filter and skips dot folders.
      command: ["bun", "test", "--coverage", "./scripts/", "./.claude/hooks/"],
      lcov: "coverage/bun/lcov.info",
      owns: BUN_OWNS,
    });
  }
  const packages = new Set(
    files.flatMap((file) => {
      const dir = PACKAGE_FILE.exec(file)?.[1];
      const vitest = dir && vitestPackage(dir, root);
      return vitest ? [vitest] : [];
    }),
  );
  for (const dir of [...packages].sort()) {
    suites.push({
      cwd: join(root, dir),
      // Its own folder, so the full run's report (coverage/lcov.info) stays what it was.
      command: ["bun", "run", "test", "--coverage", "--coverage.reportsDirectory=coverage/unit"],
      lcov: join(dir, "coverage/unit/lcov.info"),
    });
  }
  return suites;
}

/** The lines `file` misses (a line, a branch on it, or a function starting there). */
export function missedLines(file: FileCoverage): Set<number> {
  const missed = new Set<number>();
  for (const [number, hits] of file.lines) {
    if (hits === 0) {
      missed.add(number);
    }
  }
  for (const [id, taken] of file.branches) {
    if (taken === 0) {
      missed.add(Number(id.split(",")[0]));
    }
  }
  for (const [name, calls] of file.functions) {
    if (calls === 0) {
      missed.add(file.functionLines.get(name) ?? 0);
    }
  }
  return missed;
}

/**
 * The changed `lines` of `path` its unit tests leave uncovered: all of them when no suite
 * loaded it, none when it leans on integration tests (they miss unchanged lines too).
 */
export function uncovered(path: string, file: FileCoverage | undefined, lines: Set<number>) {
  if (!file) {
    return [...lines].sort((a, b) => a - b);
  }
  const missed = [...missedLines(file)].sort((a, b) => a - b);
  if (!BUN_OWNS.test(path) && missed.some((number) => !lines.has(number))) {
    return [];
  }
  return missed.filter((number) => lines.has(number));
}

/** Runs one suite; its exit code. */
export async function runSuite(suite: Suite) {
  const run = Bun.spawn(suite.command, { cwd: suite.cwd, stdout: "inherit", stderr: "inherit" });
  return run.exited;
}

/** Checks the changed lines' unit coverage; the exit code. */
export async function unitCoverage(
  argv = process.argv.slice(2),
  { root = ROOT, changed = changedLines(argv.includes("--branch")), run = runSuite } = {},
): Promise<number> {
  const exceptions = coverageExceptions(root);
  const inScope = [...changed.keys()].filter(
    (path) => unitCovered(path, root) && !exceptions.has(path),
  );
  const suites = suitesFor([...changed.keys()], root);
  if (suites.length === 0) {
    ok("no unit-tested files changed");
    return 0;
  }
  const codes = await Promise.all(suites.map(run));
  if (codes.some((code) => code !== 0)) {
    fail("unit tests failed");
    return 1;
  }
  const coverage = new Map<string, FileCoverage>();
  for (const suite of suites) {
    const lcov = join(root, suite.lcov);
    if (existsSync(lcov)) {
      mergeLcov(coverage, readFileSync(lcov, "utf8"), suite.cwd, root, suite.owns);
    }
  }
  const short = inScope
    .map((path) => ({
      path,
      lines: uncovered(path, coverage.get(path), changed.get(path) ?? new Set()),
    }))
    .filter(({ lines }) => lines.length > 0);
  for (const { path, lines } of short) {
    fail(`${path}: changed lines ${lines.join(", ")} aren't covered by its unit tests`);
  }
  if (short.length > 0) {
    console.error(
      "Every changed line needs a test (docs/testing.md): cover these in the unit test beside the file.",
    );
    return 1;
  }
  ok(`unit tests cover every changed line of ${inScope.length} file(s)`);
  return 0;
}

await runMain(import.meta, unitCoverage);
