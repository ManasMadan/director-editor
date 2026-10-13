/**
 * One coverage number for the whole repository, and the rule that every source file is
 * at 100%: lines, branches and functions.
 *
 * Every suite writes LCOV (vitest per package, jest for mobile, bun for scripts and the
 * Claude Code hooks, coverage.py for the Python service). This merges them, so a shared
 * package gets credit from the apps that really exercise it, then checks each source
 * file. The only files allowed below 100 are the ones in docs/testing.md's "Coverage
 * exceptions" table, each with the reason and the test that covers it another way.
 *
 *   bun run test:coverage          run every suite with coverage (writes the reports)
 *   bun scripts/coverage.ts        merge them, check every file, write coverage/merged.lcov
 *   bun scripts/coverage.ts apps/web packages/ui   check only the files under these paths
 *   bun scripts/coverage.ts --bun  check only the files Bun's runner answers for
 *
 * CI then runs diff-cover on coverage/merged.lcov, so a pull request can't add a line
 * without a test either.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runMain } from "./lib";
import { coverageExceptions } from "./suppressions";

const ROOT = join(import.meta.dir, "..");

/** What one file's coverage adds up to, from any number of reports. */
export interface FileCoverage {
  /** Line number → hits. */
  lines: Map<number, number>;
  /** `line,block,branch` → times taken (0 when the branch never ran). */
  branches: Map<string, number>;
  /** Function name → calls. */
  functions: Map<string, number>;
  /** Function name → the line it starts on. */
  functionLines: Map<string, number>;
}

const empty = (): FileCoverage => ({
  lines: new Map(),
  branches: new Map(),
  functions: new Map(),
  functionLines: new Map(),
});

const add = <K>(map: Map<K, number>, key: K, hits: number) =>
  map.set(key, (map.get(key) ?? 0) + hits);

/** How each LCOV record adds to a file's coverage. */
const RECORDS: Record<string, (file: FileCoverage, rest: string) => void> = {
  DA: (file, rest) => {
    const [number, hits] = rest.split(",");
    add(file.lines, Number(number), Number(hits));
  },
  BRDA: (file, rest) => {
    const [number, block, branch, taken] = rest.split(",");
    add(file.branches, `${number},${block},${branch}`, taken === "-" ? 0 : Number(taken));
  },
  // FN:<line>,<name>, or FN:<line>,<end line>,<name> (LCOV 2, as coverage.py writes it).
  FN: (file, rest) => {
    const [number, ...fields] = rest.split(",");
    const name = (/^\d+$/.test(fields[0] ?? "") ? fields.slice(1) : fields).join(",");
    file.functionLines.set(name, Number(number));
    add(file.functions, name, 0);
  },
  FNDA: (file, rest) => {
    const [hits, ...name] = rest.split(",");
    add(file.functions, name.join(","), Number(hits));
  },
};

/** The file's entry in `coverage`, created empty the first time. */
function opened(coverage: Map<string, FileCoverage>, path: string) {
  const file = coverage.get(path) ?? empty();
  coverage.set(path, file);
  return file;
}

/**
 * Parses an LCOV report into `coverage`, summing hits with what's there already. Paths
 * become relative to the repository (`base` is the directory the report's relative
 * paths are relative to). Only the files under `owns` are read, when it's given.
 */
export function mergeLcov(
  coverage: Map<string, FileCoverage>,
  lcov: string,
  base: string,
  root = ROOT,
  owns?: RegExp,
) {
  let file: FileCoverage | undefined;
  for (const line of lcov.split("\n")) {
    const [tag = "", rest = ""] = line.split(/:(.*)/s);
    if (tag === "SF") {
      const path = relative(root, rest.startsWith("/") ? rest : join(base, rest));
      file = owns?.test(path) === false ? undefined : opened(coverage, path);
    } else if (tag === "end_of_record") {
      file = undefined;
    } else if (file) {
      RECORDS[tag]?.(file, rest);
    }
  }
  return coverage;
}

/** What a file misses, as line numbers (and function names). Empty when it's all covered. */
export function misses(file: FileCoverage) {
  const lines = [...file.lines].filter(([, hits]) => hits === 0).map(([number]) => number);
  const branches = [...file.branches]
    .filter(([, taken]) => taken === 0)
    .map(([id]) => Number(id.split(",")[0]));
  const functions = [...file.functions].filter(([, calls]) => calls === 0).map(([name]) => name);
  return { lines, branches: [...new Set(branches)], functions };
}

/** The merged report, in LCOV, for diff-cover and editors. */
export function toLcov(coverage: Map<string, FileCoverage>) {
  const records = [...coverage].sort(([a], [b]) => a.localeCompare(b));
  return records
    .map(([path, file]) => {
      const out = [`SF:${path}`];
      for (const [name, line] of file.functionLines) {
        out.push(`FN:${line},${name}`);
      }
      for (const [name, calls] of file.functions) {
        out.push(`FNDA:${calls},${name}`);
      }
      for (const [id, taken] of file.branches) {
        out.push(`BRDA:${id},${taken}`);
      }
      for (const [number, hits] of [...file.lines].sort(([a], [b]) => a - b)) {
        out.push(`DA:${number},${hits}`);
      }
      return [...out, "end_of_record"].join("\n");
    })
    .join("\n");
}

/**
 * What Bun's runner (the tests in scripts/ and .claude/hooks/) answers for: every source
 * file no other suite owns. The services' and packages' src/ (and the web app's service
 * worker) are vitest's and Jest's, the Python service is pytest's; the rest is the repo's
 * tooling, all run by Bun: its scripts and hooks, the packages' build scripts and config
 * presets, the code generators, the load test, the images' checks.
 */
export const BUN_OWNS = /^(?!apps\/ai\/|apps\/[^/]+\/(src|public)\/|packages\/[^/]+\/src\/)/;

/**
 * Where the suites leave their reports, and the directory each one's paths are from.
 * Bun's report counts only for what it owns: it counts a function's first line as code
 * and v8 doesn't, so its view of a package file a script imports would add a line the
 * package's own suite never lists, and the merge would call it missed.
 */
export function reports(root = ROOT): { path: string; base: string; owns?: RegExp }[] {
  return [
    ...["apps", "packages"].flatMap((dir) =>
      existsSync(join(root, dir))
        ? [...new Bun.Glob("*/coverage/lcov.info").scanSync(join(root, dir))].map((path) => ({
            path: join(dir, path),
            base: join(root, dir, dirname(dirname(path))),
          }))
        : [],
    ),
    { path: "coverage/bun/lcov.info", base: root, owns: BUN_OWNS },
  ];
}

/** Code, in any of the repo's languages. */
const CODE = /\.(ts|tsx|js|mjs|cjs|py)$/;
/**
 * Tests and what only they run: suites, their setup, fixtures and stand-ins, end-to-end
 * and Maestro flows, the visual tests' server, stories.
 */
const TEST =
  /\.(test|spec|stories)\.tsx?$|(^|\/)test_[^/]+\.py$|(^|\/)(test|tests|e2e|maestro|visual)\/|(^|\/)jest\.setup\.ts$/;
/** Generated code: regenerated, never written by hand. */
const GENERATED = /\/generated\/|\.gen\.ts$|\.d\.ts$|\.d\.json\.ts$/;
/** Configuration a tool reads: `*.config.*`, Storybook's and dependency-cruiser's. */
const CONFIG =
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)\.storybook\/|(^|\/)\.dependency-cruiser\.cjs$/;

/**
 * Source files the rule applies to: every file of code git tracks, wherever it is, but
 * tests, generated code and configs. A new folder of code is covered the day it lands.
 */
export function isSource(path: string) {
  return CODE.test(path) && !TEST.test(path) && !GENERATED.test(path) && !CONFIG.test(path);
}

/**
 * Merges the reports under `root`, writes coverage/merged.lcov and names every source file
 * under `scopes` (all of them when empty; `--bun` for the ones Bun's runner owns) below
 * 100%; the exit code.
 */
export function checkCoverage(scopes = process.argv.slice(2), root = ROOT): number {
  const coverage = new Map<string, FileCoverage>();
  const found = reports(root).filter(({ path }) => existsSync(join(root, path)));
  if (found.length === 0) {
    console.error("No coverage reports: run `bun run test:coverage` first.");
    return 1;
  }
  for (const { path, base, owns } of found) {
    mergeLcov(coverage, readFileSync(join(root, path), "utf8"), base, root, owns);
  }
  mkdirSync(join(root, "coverage"), { recursive: true });
  const measured = new Map([...coverage].filter(([path]) => isSource(path)));
  writeFileSync(join(root, "coverage/merged.lcov"), `${toLcov(measured)}\n`);
  const inScope = (path: string) =>
    scopes.length === 0 ||
    scopes.some((scope) =>
      scope === "--bun" ? BUN_OWNS.test(path) : path.startsWith(scope.replace(/\/?$/, "/")),
    );
  for (const path of measured.keys()) {
    if (!inScope(path)) {
      measured.delete(path);
    }
  }

  // A source file no test ever loads is in no report at all: it counts as uncovered.
  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().split("\n");
  const unloaded = tracked.filter((path) => isSource(path) && inScope(path) && !measured.has(path));

  const exceptions = coverageExceptions(root);
  for (const path of unloaded.filter((path) => !exceptions.has(path))) {
    console.error(`  \x1b[31m✖\x1b[0m ${path}: no test loads it`);
  }
  const short = [...measured]
    .map(([path, file]) => ({ path, ...misses(file) }))
    .filter(
      ({ path, lines, branches, functions }) =>
        !exceptions.has(path) && lines.length + branches.length + functions.length > 0,
    );
  for (const { path, lines, branches, functions } of short) {
    const parts = [
      lines.length && `lines ${lines.join(", ")}`,
      branches.length && `branches on ${branches.join(", ")}`,
      functions.length && `functions ${functions.join(", ")}`,
    ].filter(Boolean);
    console.error(`  \x1b[31m✖\x1b[0m ${path}: ${parts.join("; ")}`);
  }
  const failing = short.length + unloaded.filter((path) => !exceptions.has(path)).length;
  console.log(
    `${measured.size + unloaded.length} source files, ${found.length} reports: ${failing} below 100%.`,
  );
  return failing > 0 ? 1 : 0;
}

await runMain(import.meta, checkCoverage);
