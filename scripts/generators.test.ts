import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generators } from "./generators";
import { ROOT } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** Every check passes; the test steps say how many tests passed, as vitest does. */
const passing = (line: string) =>
  line.includes("vitest") || line === "bun run test" ? { stdout: "Tests  12 passed (12)" } : {};

describe("the generators check", () => {
  it("runs both generators and every check here with --in-place", () => {
    const printed = captureOutput();
    const { run, calls, options } = fakeRun(passing);
    expect(generators(["--in-place"], run)).toBe(0);
    expect(calls).toEqual([
      'bunx turbo gen api-feature --args smoke-notes smoke-note todo {"title":"Smoke"}',
      "bunx turbo gen package --args smoke-kit A package the generators check makes.",
      "bun run lint",
      "bun run check-types",
      "bun run test",
      "bunx vitest run --project integration test/api.integration.test.ts -t smoke-notes",
    ]);
    expect(options.map((option) => option.cwd)).toEqual([
      ...Array(5).fill(ROOT),
      join(ROOT, "apps/api"),
    ]);
    expect(printed()).toContain("both generators write code that passes");
  });

  it("works in a scratch copy of the checkout, working tree included, and removes it after", () => {
    captureOutput();
    let dir = "";
    let copied = "";
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("git worktree add")) {
        dir = line.split(" ")[5] as string;
      }
      if (line.startsWith("git ls-files")) {
        return { stdout: "package.json\0deleted.ts\0" };
      }
      if (line === "bun install --frozen-lockfile") {
        copied = readFileSync(join(dir, "package.json"), "utf8");
      }
      return passing(line);
    });
    expect(generators([], run)).toBe(0);
    expect(copied).toBe(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(calls[0]).toBe(`git worktree add --detach --quiet ${dir} HEAD`);
    expect(calls.at(-1)).toBe(`git worktree remove --force ${dir}`);
    expect(existsSync(dir)).toBe(false);
  });

  it("stops when the scratch copy can't be made", () => {
    const { run } = fakeRun((line) =>
      line.startsWith("git worktree add") ? { status: 128, stderr: "fatal: no HEAD" } : {},
    );
    expect(() => generators([], run)).toThrow("failed:\nfatal: no HEAD");
  });

  it.each([
    ["a check fails", "bun run check-types", { status: 2, stdout: "error TS2322" }, "types"],
    [
      "a generator's action fails, though turbo exits 0",
      "bunx turbo gen package --args smoke-kit A package the generators check makes.",
      { stdout: ">>> Error: file exists" },
      "generate a package",
    ],
    ["a test step runs no test", "bun run test", { stdout: "No test files found" }, "unit tests"],
  ])("fails when %s, and shows its output", (_, failing, result, label) => {
    const printed = captureOutput();
    const { run, calls } = fakeRun((line) => (line === failing ? result : passing(line)));
    expect(generators(["--in-place"], run)).toBe(1);
    expect(calls.at(-1)).toBe(failing);
    expect(printed()).toContain(label);
    expect(printed()).toContain(String(result.stdout));
  });
});
