import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { checkMarkers, findMarkers } from "./check-markers";
import { captureOutput } from "./stand-ins";

afterEach(() => mock.restore());

describe("the marker check", () => {
  it("reports each marked line of a source file, with its line number", () => {
    const text = "const a = 1;\n// ponytail: a global lock\nconst b = 2;\n  # ponytail: naive\n";
    expect(findMarkers("apps/api/src/x.ts", text)).toEqual([
      "apps/api/src/x.ts:2: // ponytail: a global lock",
      "apps/api/src/x.ts:4: # ponytail: naive",
    ]);
    expect(findMarkers("apps/ai/app/x.py", "# ponytail: naive\n")).toHaveLength(1);
  });

  it("passes clean source", () => {
    expect(findMarkers("apps/api/src/x.ts", "// A count check, not a lock.\n")).toEqual([]);
    expect(findMarkers("apps/api/src/x.ts", "const ponytails = 2;\n")).toEqual([]);
  });

  it("ignores prose and the files that define the marker", () => {
    expect(findMarkers("docs/testing.md", "ponytail: x\n")).toEqual([]);
    expect(findMarkers("scripts/check-markers.ts", "// ponytail: x\n")).toEqual([]);
    expect(findMarkers("scripts/check-markers.test.ts", "// ponytail: x\n")).toEqual([]);
  });
});

describe("the check over tracked files", () => {
  it("fails on a marked tracked file and passes once it's rewritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "markers-"));
    await $`git init -q && git config user.email t@example.com && git config user.name t`.cwd(root);
    writeFileSync(join(root, "x.ts"), "// ponytail: a global lock\n");
    writeFileSync(join(root, "notes.md"), "ponytail: prose\n");
    await $`git add .`.cwd(root);
    const printed = captureOutput();
    expect(checkMarkers(root)).toBe(1);
    expect(printed()).toContain("x.ts:1: // ponytail: a global lock");
    writeFileSync(join(root, "x.ts"), "// A global lock: one writer at a time.\n");
    expect(checkMarkers(root)).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});
