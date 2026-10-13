import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureOutput } from "./stand-ins";
import {
  changedLines,
  parseDiff,
  runSuite,
  type Suite,
  suitesFor,
  uncovered,
  unitCoverage,
  unitCovered,
} from "./unit-coverage";

afterEach(() => mock.restore());

/** A repository in a temporary folder with `files` (path → content). */
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "unit-coverage-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const VITEST = JSON.stringify({ scripts: { test: "vitest run --project unit" } });
const lines = (...numbers: number[]) => new Set(numbers);

describe("reading a diff", () => {
  it("takes each hunk's new lines, and skips deletions", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +2,3 @@",
      "@@ -9 +12 @@ const x = 1;",
      "@@ -20,2 +23,0 @@",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
    ].join("\n");
    expect(parseDiff(diff)).toEqual(new Map([["a.ts", lines(2, 3, 4, 12)]]));
  });

  it("is what a push sends: the commits its upstream lacks", () => {
    const calls: string[] = [];
    changedLines(true, (args) => {
      calls.push(args.join(" "));
      return args[0] === "rev-parse" ? "origin/feature\n" : "";
    });
    expect(calls).toContain("merge-base HEAD origin/feature");
  });

  it("is the branch's commits since the merge base, or the working tree with new files whole", () => {
    const root = repo({ "new.ts": "a\nb\n" });
    const calls: string[] = [];
    const git = (args: string[]) => {
      calls.push(args.join(" "));
      // A branch never pushed: no upstream.
      if (args[0] === "rev-parse") {
        return "";
      }
      if (args[0] === "symbolic-ref") {
        return "origin/main\n";
      }
      if (args[0] === "merge-base") {
        return "abc\n";
      }
      if (args[0] === "ls-files") {
        return "new.ts\n";
      }
      return "+++ b/x.ts\n@@ -1 +1 @@\n";
    };
    expect(changedLines(true, git, root)).toEqual(new Map([["x.ts", lines(1)]]));
    expect(calls).toContain("merge-base HEAD origin/main");
    expect(calls).toContain("diff -U0 --no-color --no-ext-diff abc HEAD");
    expect(changedLines(false, git, root)).toEqual(
      new Map([
        ["x.ts", lines(1)],
        ["new.ts", lines(1, 2)],
      ]),
    );
    // No remote: the local default branch.
    const noRemote: string[] = [];
    changedLines(
      true,
      (args) => {
        noRemote.push(args.join(" "));
        return "";
      },
      root,
    );
    expect(noRemote).toContain("merge-base HEAD master");
    // The real repository, through git itself.
    expect(changedLines(false)).toBeInstanceOf(Map);
  });
});

describe("which files unit tests must cover", () => {
  const root = repo({
    "packages/p/package.json": VITEST,
    "packages/p/src/pure.ts": "",
    "packages/p/src/pure.test.ts": "",
    "packages/p/src/view.tsx": "",
    "packages/p/src/view.test.tsx": "",
    "packages/p/src/service.ts": "",
    "apps/mobile/package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "apps/mobile/src/a.ts": "",
    "apps/mobile/src/a.test.ts": "",
    "apps/api/package.json": JSON.stringify({
      scripts: { test: "vitest run --project unit", "test:integration": "vitest run" },
    }),
    "apps/api/src/auth.ts": "",
    "apps/api/src/auth.test.ts": "",
  });

  it("are scripts/, the hooks, and package files with a vitest unit test beside them", () => {
    expect(unitCovered("scripts/lib.ts", root)).toBe(true);
    expect(unitCovered(".claude/hooks/lib.ts", root)).toBe(true);
    expect(unitCovered("packages/p/src/pure.ts", root)).toBe(true);
    expect(unitCovered("packages/p/src/view.tsx", root)).toBe(true);
    expect(unitCovered("packages/p/src/service.ts", root)).toBe(false);
    expect(unitCovered("apps/mobile/src/a.ts", root)).toBe(false);
    // Its integration tests reach what the unit tests don't: CI's diff-cover judges it.
    expect(unitCovered("apps/api/src/auth.ts", root)).toBe(false);
    expect(unitCovered("packages/gone/src/a.ts", root)).toBe(false);
    expect(unitCovered("packages/p/src/pure.test.ts", root)).toBe(false);
    expect(unitCovered("docs/testing.md", root)).toBe(false);
  });

  it("run Bun's suite for scripts/ and the hooks, and each package's vitest unit run", () => {
    const suites = suitesFor(
      [
        "scripts/lib.test.ts",
        "packages/p/src/service.ts",
        "apps/mobile/src/a.ts",
        "apps/api/src/auth.ts",
        "README.md",
      ],
      root,
    );
    expect(suites.map((suite) => [suite.cwd, suite.command.join(" "), suite.lcov])).toEqual([
      [root, "bun test --coverage ./scripts/ ./.claude/hooks/", "coverage/bun/lcov.info"],
      [
        join(root, "packages/p"),
        "bun run test --coverage --coverage.reportsDirectory=coverage/unit",
        "packages/p/coverage/unit/lcov.info",
      ],
    ]);
    expect(suitesFor(["docs/x.md"], root)).toEqual([]);
    // The tooling outside scripts/ is Bun's too; a service's tests aren't.
    expect(suitesFor(["deploy/docker/check-peers.mjs"], root)).toHaveLength(1);
    expect(suitesFor(["apps/api/test/x.test.ts"], root)).toEqual([]);
  });
});

describe("what a file leaves uncovered", () => {
  const file = (missed: { lines?: number[]; branch?: number; fn?: number }) => ({
    lines: new Map([[1, 1], ...(missed.lines ?? []).map((n): [number, number] => [n, 0])]),
    branches: new Map(missed.branch ? [[`${missed.branch},0,0`, 0]] : []),
    functions: new Map(missed.fn ? [["f", 0]] : []),
    functionLines: new Map(missed.fn ? [["f", missed.fn]] : []),
  });

  it("is the changed lines it misses: lines, branches and functions", () => {
    const path = "packages/p/src/a.ts";
    expect(uncovered(path, file({ lines: [2], branch: 3, fn: 4 }), lines(2, 3, 4))).toEqual([
      2, 3, 4,
    ]);
    expect(uncovered(path, undefined, lines(5, 2))).toEqual([2, 5]);
  });

  it("is nothing in a package file that leans on integration tests, but never in scripts/", () => {
    const missesOthers = file({ lines: [2, 9] });
    expect(uncovered("packages/p/src/a.ts", missesOthers, lines(2))).toEqual([]);
    expect(uncovered("scripts/a.ts", missesOthers, lines(2))).toEqual([2]);
  });
});

describe("the unit coverage check", () => {
  const root = repo({
    "packages/p/package.json": VITEST,
    "packages/p/src/pure.ts": "",
    "packages/p/src/pure.test.ts": "",
    "docs/testing.md": "## Coverage exceptions\n\n| `packages/p/src/listed.ts` | why |\n",
    "packages/p/src/listed.ts": "",
    "packages/p/src/listed.test.ts": "",
  });
  const lcov = (body: string) => async (suite: Suite) => {
    mkdirSync(dirname(join(root, suite.lcov)), { recursive: true });
    writeFileSync(join(root, suite.lcov), body);
    return 0;
  };
  const changed = new Map([
    ["packages/p/src/pure.ts", lines(2)],
    ["packages/p/src/listed.ts", lines(1)],
  ]);

  it("passes when the unit tests cover every changed line", async () => {
    const output = captureOutput();
    const run = lcov("SF:src/pure.ts\nDA:2,1\nend_of_record\n");
    expect(await unitCoverage([], { root, changed, run })).toBe(0);
    expect(output()).toContain("cover every changed line of 1 file(s)");
  });

  it("names the changed lines they miss, leaving out listed exceptions", async () => {
    const output = captureOutput();
    const run = lcov(
      "SF:src/pure.ts\nDA:2,0\nend_of_record\nSF:src/listed.ts\nDA:1,0\nend_of_record\n",
    );
    expect(await unitCoverage([], { root, changed, run })).toBe(1);
    expect(output()).toContain("packages/p/src/pure.ts: changed lines 2");
    expect(output()).not.toContain("listed.ts");
  });

  it("fails when the tests fail, and passes when nothing unit-tested changed", async () => {
    const output = captureOutput();
    expect(await unitCoverage([], { root, changed, run: async () => 1 })).toBe(1);
    expect(output()).toContain("unit tests failed");
    const docs = new Map([["docs/x.md", lines(1)]]);
    expect(await unitCoverage([], { root, changed: docs })).toBe(0);
    // A suite that wrote no report: its files count as unloaded.
    const fresh = repo({ "scripts/a.ts": "" });
    const script = new Map([["scripts/a.ts", lines(1)]]);
    expect(await unitCoverage([], { root: fresh, changed: script, run: async () => 0 })).toBe(1);
    expect(output()).toContain("scripts/a.ts: changed lines 1");
  });

  it("runs a suite's command in its folder", async () => {
    expect(await runSuite({ cwd: root, command: ["true"], lcov: "x" })).toBe(0);
    expect(await runSuite({ cwd: root, command: ["false"], lcov: "x" })).toBe(1);
  });
});
