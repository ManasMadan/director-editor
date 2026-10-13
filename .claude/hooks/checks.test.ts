import { describe, expect, it } from "bun:test";
import { checksFor, touchesEverything } from "./checks";

const labels = (changed: string[]) => checksFor(changed).map((check) => check.label);

describe("the Stop hook's checks", () => {
  it("run Biome on changed code, turbo for the packages, and the changed lines' unit coverage", () => {
    expect(labels(["apps/api/src/main.ts"])).toEqual([
      "Biome on the changed files",
      "lint, types and unit tests of the affected packages",
      "unit tests and the coverage of the changed lines",
      "suppressions",
      "knip",
    ]);
    expect(labels(["apps/ai/app/x.py"])).toEqual([
      "lint, types and unit tests of the affected packages",
      "suppressions",
    ]);
    expect(labels(["apps/api/test/x.test.ts"])).not.toContain(
      "unit tests and the coverage of the changed lines",
    );
    const biome = checksFor(["apps/api/src/main.ts", "docs/x.md"])[0];
    expect(biome?.command.slice(-1)).toEqual(["apps/api/src/main.ts"]);
  });

  it("check scripts/ and the hooks themselves, which turbo can't see", () => {
    expect(labels(["scripts/lib.ts"])).toEqual([
      "Biome on the changed files",
      "types of scripts/",
      "unit tests and the coverage of the changed lines",
      "suppressions",
      "knip",
    ]);
    const hooks = checksFor([".claude/hooks/lib.ts"]);
    expect(hooks.map((check) => check.command.join(" "))).toContain("bunx tsc -p .claude/hooks");
    expect(hooks.find((check) => check.command[0] === "bun")?.command).toEqual([
      "bun",
      "scripts/unit-coverage.ts",
    ]);
  });

  it("check suppressions wherever one can be written, and when the list allowing them changes", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "biome.jsonc",
      ".husky/pre-commit",
      "docs/testing.md",
    ]) {
      expect(labels([file])).toContain("suppressions");
    }
  });

  it("run nothing for a change no check covers", () => {
    expect(labels(["docs/deploy.md"])).toEqual([]);
  });

  it("know which changes every package depends on", () => {
    expect(touchesEverything(["bun.lock"])).toBe(true);
    expect(touchesEverything(["apps/api/package.json"])).toBe(false);
  });
});
