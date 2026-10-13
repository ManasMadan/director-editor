import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "./lib";
import { affected, diffCover, pushCoverage } from "./push-coverage";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const listing = (...paths: string[]) =>
  JSON.stringify({ packages: { items: paths.map((path) => ({ name: path, path })) } });

/** A machine where git says the push starts at `abc`, with these answers for the rest. */
function machine(answers: (line: string) => Partial<Ran> | undefined = () => undefined) {
  return fakeRun((line) => {
    if (line.startsWith("git merge-base")) {
      return { stdout: "abc\n" };
    }
    if (line.startsWith("git ")) {
      return { stdout: "" };
    }
    return answers(line);
  });
}

describe("the push's coverage", () => {
  it("runs every suite of what the push affects, then checks those folders file by file", () => {
    const output = captureOutput();
    const { run, calls } = machine((line) =>
      line.startsWith("bunx turbo ls") ? { stdout: listing("apps/api", "packages/db") } : undefined,
    );
    expect(pushCoverage({ run, argv: [] })).toBe(0);
    expect(calls.filter((line) => !line.startsWith("git "))).toEqual([
      "bunx turbo ls --filter=...[abc] --output=json",
      "docker info",
      "bun scripts/services.ts up",
      "docker compose --profile files up -d --wait rustfs",
      "bunx turbo run coverage --filter=...[abc] --concurrency=2",
      "bun test --coverage ./scripts/ ./.claude/hooks/",
      "bun scripts/coverage.ts apps/api packages/db --bun",
      `uvx ${diffCover()} coverage/merged.lcov --compare-branch abc --fail-under 100`,
    ]);
    expect(output()).toContain("every file in 2 package(s) and the repo's tooling at 100%");
  });

  it("checks only the scripts and hooks when no package is affected", () => {
    captureOutput();
    const { run, calls } = machine((line) =>
      line.startsWith("bunx turbo ls") ? { stdout: listing() } : undefined,
    );
    expect(pushCoverage({ run, argv: ["--concurrency=6"] })).toBe(0);
    expect(calls.some((line) => line.startsWith("docker") || line.startsWith("uvx"))).toBe(false);
    expect(calls.at(-1)).toBe("bun scripts/coverage.ts --bun");
  });

  it("refuses the push when Docker or a service is down, or a suite fails", () => {
    const output = captureOutput();
    const listed = (line: string) =>
      line.startsWith("bunx turbo ls") ? { stdout: listing("apps/api") } : undefined;
    const failing = (prefix: string) =>
      machine((line) => listed(line) ?? (line.startsWith(prefix) ? { status: 1 } : undefined));
    expect(pushCoverage({ run: failing("docker info").run })).toBe(1);
    expect(output()).toContain("Docker isn't running");
    expect(pushCoverage({ run: failing("bun scripts/services.ts").run })).toBe(1);
    expect(pushCoverage({ run: failing("docker compose").run })).toBe(1);
    expect(pushCoverage({ run: failing("bunx turbo run").run })).toBe(1);
    expect(output()).toContain("tests failed");
    expect(pushCoverage({ run: failing("bun test").run })).toBe(1);
    expect(output()).toContain("left a file below 100%");
    expect(pushCoverage({ run: failing("bun scripts/coverage.ts").run })).toBe(1);
    expect(pushCoverage({ run: failing("uvx").run })).toBe(1);
    expect(output()).toContain("isn't covered (diff-cover above)");
  });

  it("runs as many suites at once as it's told", () => {
    captureOutput();
    const { run, calls } = machine((line) =>
      line.startsWith("bunx turbo ls") ? { stdout: listing("apps/api") } : undefined,
    );
    expect(pushCoverage({ run, argv: ["--concurrency=6"] })).toBe(0);
    expect(calls).toContain("bunx turbo run coverage --filter=...[abc] --concurrency=6");
  });

  it("takes diff-cover's version from CI's coverage job, and says when it can't", () => {
    expect(diffCover()).toMatch(/^diff-cover@\d+\.\d+\.\d+$/);
    const root = mkdtempSync(join(tmpdir(), "push-coverage-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/ci.yml"), "jobs: {}\n");
    expect(() => diffCover(root)).toThrow("no longer runs `uvx diff-cover@<version>`");
  });

  it("stops when turbo can't list the packages", () => {
    const { run } = machine((line) =>
      line.startsWith("bunx turbo ls") ? { status: 1, stderr: "no git" } : undefined,
    );
    expect(() => affected("abc", run)).toThrow("turbo ls failed: no git");
  });
});
