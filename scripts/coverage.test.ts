import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { coverage } from "../packages/vitest-config";
import { checkCoverage, type FileCoverage, isSource, mergeLcov, misses, toLcov } from "./coverage";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

const ROOT = join(import.meta.dir, "..");

const report = (path: string, body: string[]) =>
  [`SF:${path}`, ...body, "end_of_record"].join("\n");

describe("merging coverage", () => {
  it("adds up what every suite saw of a file, so shared code gets credit from its callers", () => {
    const coverage = new Map<string, FileCoverage>();
    // The package's own tests reach one branch; an app's tests reach the other.
    mergeLcov(
      coverage,
      report("src/lib.ts", [
        "FN:1,run",
        "FNDA:1,run",
        "BRDA:2,0,0,1",
        "BRDA:2,0,1,0",
        "DA:1,1",
        "DA:3,0",
      ]),
      join(ROOT, "packages/pkg"),
    );
    mergeLcov(
      coverage,
      report(join(ROOT, "packages/pkg/src/lib.ts"), [
        "FN:1,run",
        "FNDA:0,run",
        "BRDA:2,0,1,2",
        "DA:3,4",
      ]),
      join(ROOT, "apps/app"),
    );
    const file = coverage.get("packages/pkg/src/lib.ts") as FileCoverage;
    expect(misses(file)).toEqual({ lines: [], branches: [], functions: [] });
    expect(file.lines.get(3)).toBe(4);
  });

  it("names what's left: lines, the lines of branches never taken, and functions never called", () => {
    const coverage = mergeLcov(
      new Map(),
      report("src/a.ts", ["FN:5,never", "FNDA:0,never", "BRDA:7,0,0,-", "DA:5,0", "DA:6,1"]),
      join(ROOT, "packages/pkg"),
    );
    expect(misses(coverage.get("packages/pkg/src/a.ts") as FileCoverage)).toEqual({
      lines: [5],
      branches: [7],
      functions: ["never"],
    });
  });

  it("reads coverage.py's functions, which give their end line too", () => {
    const coverage = mergeLcov(
      new Map(),
      report("app/usage.py", ["FN:47,57,settle", "FNDA:3,settle", "DA:47,3"]),
      join(ROOT, "apps/ai"),
    );
    expect(misses(coverage.get("apps/ai/app/usage.py") as FileCoverage).functions).toEqual([]);
  });

  it("writes the merged report back as LCOV that reads the same", () => {
    const coverage = mergeLcov(
      new Map(),
      report("src/a.ts", ["FN:1,f", "FNDA:2,f", "BRDA:1,0,0,1", "DA:3,0", "DA:1,2"]),
      join(ROOT, "packages/pkg"),
    );
    const again = mergeLcov(new Map(), toLcov(coverage), ROOT);
    expect(again).toEqual(coverage);
  });
});

describe("which files the rule applies to", () => {
  it.each([
    ["apps/api/src/server.ts", true],
    ["apps/ai/app/main.py", true],
    ["packages/client/src/errors.ts", true],
    ["scripts/release.ts", true],
    [".claude/hooks/lib.ts", true],
    ["apps/api/src/server.test.ts", false],
    ["apps/web/e2e/auth.spec.ts", false],
    ["packages/ui/src/components/button.stories.tsx", false],
    ["apps/api/src/generated/client.ts", false],
    ["packages/ai-client/src/generated/types.gen.ts", false],
    ["apps/ai/tests/test_errors.py", false],
    ["apps/api/vitest.config.ts", false],
    ["apps/ai/evals/library.py", true],
    ["apps/web/public/sw.js", true],
    ["deploy/docker/check-peers.mjs", true],
    ["packages/jobs/scripts/export-schemas.ts", true],
    ["packages/vitest-config/index.ts", true],
    ["turbo/generators/config.ts", true],
    ["load/api.ts", true],
    ["apps/web/test/services.ts", false],
    ["apps/ai/tests/support.py", false],
    ["apps/mobile/maestro/scripts/code.js", false],
    ["apps/mobile/jest.setup.ts", false],
    ["packages/ui/visual/serve.mjs", false],
    ["apps/web/next.config.ts", false],
    ["packages/ui/.storybook/preview.tsx", false],
    [".dependency-cruiser.cjs", false],
    ["packages/i18n/messages/en.d.json.ts", false],
    ["README.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isSource(path)).toBe(expected);
  });

  it("counts code in a folder it has never seen: only tests, generated code and configs are out", () => {
    for (const path of [
      "tools/release.ts",
      "apps/new/lib/format.tsx",
      "packages/new/bin/run.mjs",
      "infra/scripts/rotate.py",
      "deploy/docker/healthcheck.cjs",
      "apps/web/public/worker.js",
    ]) {
      expect(isSource(path)).toBe(true);
    }
  });
});

describe("the check", () => {
  /** A repository holding `files` (path → content), all tracked. */
  async function repo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "coverage-"));
    await $`git init -q`.cwd(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    await $`git add .`.cwd(root);
    return root;
  }

  function run(scopes: string[], root: string) {
    const printed = captureOutput();
    const code = checkCoverage(scopes, root);
    const output = printed();
    mock.restore();
    return { code, printed: output };
  }

  it("fails without reports to check", async () => {
    const { code, printed } = run([], await repo({ "scripts/a.ts": "" }));
    expect(code).toBe(1);
    expect(printed).toContain("No coverage reports");
  });

  it("names what each file misses, and the files no test loads, except the listed ones", async () => {
    const root = await repo({
      "scripts/full.ts": "",
      "scripts/short.ts": "",
      "scripts/unloaded.ts": "",
      "scripts/listed.ts": "",
      "packages/pkg/src/index.ts": "",
      "docs/testing.md": "## Coverage exceptions\n| `scripts/listed.ts` | native only | e2e |\n",
      "coverage/bun/lcov.info": [
        report("scripts/full.ts", ["DA:1,1"]),
        report("scripts/short.ts", ["FN:2,run", "FNDA:0,run", "BRDA:3,0,0,0", "DA:4,0"]),
        report("scripts/listed.ts", ["DA:1,0"]),
        report("scripts/full.test.ts", ["DA:1,0"]),
      ].join("\n"),
      "packages/pkg/coverage/lcov.info": report("src/index.ts", ["DA:1,1"]),
    });
    const { code, printed } = run(["scripts"], root);
    expect(code).toBe(1);
    expect(printed).toContain("scripts/short.ts: lines 4; branches on 3; functions run");
    expect(printed).toContain("scripts/unloaded.ts: no test loads it");
    expect(printed).not.toContain("listed.ts");
    expect(printed).not.toContain("packages/pkg");
    expect(printed).toContain("4 source files, 2 reports: 2 below 100%.");
    // The merged report keeps every source file, whatever the scope, and no tests.
    const merged = readFileSync(join(root, "coverage/merged.lcov"), "utf8");
    expect(merged).toContain("SF:packages/pkg/src/index.ts");
    expect(merged).not.toContain("full.test.ts");
  });

  it("holds a file another exceptions table lists to 100% all the same", async () => {
    const root = await repo({
      "scripts/suppressed.ts": "",
      "docs/testing.md": "## Suppressions\n| `scripts/suppressed.ts` | a lint rule | why |\n",
      "coverage/bun/lcov.info": report("scripts/suppressed.ts", ["DA:1,0"]),
    });
    const { code, printed } = run(["scripts"], root);
    expect(code).toBe(1);
    expect(printed).toContain("scripts/suppressed.ts: lines 1");
  });

  it("judges a package's file by vitest's view of it, not by what bun saw of it", async () => {
    // Bun counts a function's first line as a line of code and v8 doesn't: a package file
    // a script imports would miss that line in the merge, though its own suite ran it.
    const root = await repo({
      "packages/pkg/src/index.ts": "",
      "packages/pkg/coverage/lcov.info": report("src/index.ts", ["DA:2,1"]),
      "coverage/bun/lcov.info": report("packages/pkg/src/index.ts", ["DA:1,0", "DA:2,0"]),
    });
    expect(run(["packages"], root).code).toBe(0);
  });

  it("checks only what Bun's runner owns with --bun", async () => {
    const root = await repo({
      "packages/pkg/src/index.ts": "",
      "packages/pkg/scripts/gen.ts": "",
      "deploy/check.mjs": "",
      "coverage/bun/lcov.info": [
        report("packages/pkg/scripts/gen.ts", ["DA:1,1"]),
        report("deploy/check.mjs", ["DA:1,0"]),
        report("packages/pkg/src/index.ts", ["DA:1,0"]),
      ].join("\n"),
    });
    const { code, printed } = run(["--bun"], root);
    expect(code).toBe(1);
    expect(printed).toContain("deploy/check.mjs: lines 1");
    expect(printed).not.toContain("packages/pkg/src");
    expect(printed).toContain("2 source files, 1 reports: 1 below 100%.");
  });

  it("passes when every file in scope is covered", async () => {
    const root = await repo({
      "packages/pkg/src/index.ts": "",
      "scripts/short.ts": "",
      "packages/pkg/coverage/lcov.info": report("src/index.ts", ["DA:1,1"]),
      "coverage/bun/lcov.info": report("scripts/short.ts", ["DA:1,0"]),
    });
    expect(run(["packages/pkg/"], root)).toEqual({
      code: 0,
      printed: "1 source files, 2 reports: 0 below 100%.",
    });
    expect(run([], root).code).toBe(1);
  });
});

describe("vitest's coverage settings", () => {
  // v8 parses every file a test imports as JavaScript; an imported JSON file (the i18n
  // messages) fails to parse and logs an error for each run that loads it.
  it("leave data files out, so only code is measured", () => {
    const excluded = (path: string) =>
      (coverage().exclude ?? []).some((pattern) => new Bun.Glob(pattern).match(path));
    expect(excluded("packages/i18n/messages/en.json")).toBe(true);
    expect(excluded("packages/i18n/src/index.ts")).toBe(false);
  });
});
