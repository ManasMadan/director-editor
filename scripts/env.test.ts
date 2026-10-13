import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSet } from "./env-set";
import { envUnset } from "./env-unset";
import { captureOutput } from "./stand-ins";

let file: string;
let printed: () => string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
  writeFileSync(file, "A=1\n");
  printed = captureOutput();
});
afterEach(() => mock.restore());

const stdin = (text: string) => ({ text: async () => text });

describe("env:set", () => {
  it("sets a value from the argument, keeping what follows the first =", async () => {
    expect(await envSet(["B=x=y"], file, stdin(""))).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("A=1\nB=x=y\n");
    expect(printed()).toContain("B updated in .env");
  });

  it("reads the value from stdin, so it never shows in the process list", async () => {
    expect(await envSet(["A"], file, stdin("sk_test_1\n"))).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("A=sk_test_1\n");
  });

  it("refuses a missing or badly named variable, and a value .env can't hold", async () => {
    expect(await envSet([], file, stdin(""))).toBe(1);
    expect(printed()).toContain("Usage: bun run env:set");
    expect(await envSet(["lower=1"], file, stdin(""))).toBe(1);
    expect(printed()).toContain('Invalid variable name "lower"');
    expect(await envSet(["B=a$b"], file, stdin(""))).toBe(1);
    expect(printed()).toContain("Bun expands it");
    expect(readFileSync(file, "utf8")).toBe("A=1\n");
  });
});

describe("env:unset", () => {
  it("removes a variable, and says when it isn't there", () => {
    expect(envUnset(["A"], file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("");
    expect(printed()).toContain("A removed from .env");
    expect(envUnset(["A"], file)).toBe(0);
    expect(printed()).toContain("A isn't in .env");
  });

  it("removes several at once, as the doctor suggests for stale ones", () => {
    writeFileSync(file, "A=1\nB=2\nC=3\n");
    expect(envUnset(["A", "C"], file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("B=2\n");
  });

  it("refuses a missing or badly named variable", () => {
    expect(envUnset([], file)).toBe(1);
    expect(envUnset(["a"], file)).toBe(1);
    expect(envUnset(["A", "b"], file)).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("A=1\n");
    expect(printed()).toContain("Usage: bun run env:unset KEY");
  });
});
