import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPrisma } from "./format-prisma";
import { ROOT } from "./lib";
import { STEPS } from "./lint";
import { lintMigrations } from "./lint-migrations";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

describe("formatting the Prisma schema", () => {
  it("formats the whole schema from its package, and exits as Prisma does", () => {
    const { run, calls, options } = fakeRun(() => ({ status: 2 }));
    expect(formatPrisma([], run)).toBe(2);
    expect(calls).toEqual(["bunx prisma format"]);
    expect(options[0]?.cwd).toBe(join(ROOT, "packages/db"));
    expect(formatPrisma([], fakeRun(() => ({ status: null })).run)).toBe(1);
  });

  it("only checks it in bun run lint, so a commit made without the hook fails CI", () => {
    const { run, calls } = fakeRun(() => ({ status: 1 }));
    expect(formatPrisma(["--check"], run)).toBe(1);
    expect(calls).toEqual(["bunx prisma format --check"]);
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts["lint:prisma"]).toBe("bun scripts/format-prisma.ts --check");
    expect(STEPS.map((step) => step.join(" "))).toContain("bun run lint:prisma");
  });
});

describe("linting migrations", () => {
  const migration = "packages/db/prisma/migrations/2_x/migration.sql";

  it("lints the migrations changed since master", () => {
    const { run, calls } = fakeRun((line) =>
      line.startsWith("git")
        ? { stdout: `${migration}\npackages/db/prisma/schema.prisma\n` }
        : { status: 4 },
    );
    expect(lintMigrations([], {}, run)).toBe(4);
    expect(calls).toEqual([
      "git diff --name-only --diff-filter=AM master...HEAD -- packages/db/prisma/migrations",
      `bunx squawk-cli@2.66.0 ${migration}`,
    ]);
  });

  it("compares with a pull request's base, and lints given files instead", () => {
    const { run, calls } = fakeRun((line) => (line.startsWith("bunx") ? { status: null } : {}));
    expect(lintMigrations([migration], { GITHUB_BASE_REF: "main" }, run)).toBe(1);
    expect(calls[0]).toContain("origin/main...HEAD");
    expect(calls[1]).toBe(`bunx squawk-cli@2.66.0 ${migration}`);
  });

  it("passes when no migration changed", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun();
    expect(lintMigrations([], {}, run)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(printed()).toContain("no new migrations since master");
  });

  it("fails when git can't compare", () => {
    const printed = captureOutput();
    const { run } = fakeRun(() => ({ status: 128, stderr: "fatal: bad revision" }));
    expect(lintMigrations([], {}, run)).toBe(1);
    expect(printed()).toContain("fatal: bad revision");
  });
});
