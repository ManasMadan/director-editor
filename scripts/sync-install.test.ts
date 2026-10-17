import { afterEach, describe, expect, it, mock } from "bun:test";
import { captureOutput, fakeRun } from "./stand-ins";
import { syncInstall } from "./sync-install";

afterEach(() => mock.restore());

const changed = (line: string) => (line.startsWith("git diff") ? { status: 1 } : undefined);

describe("reinstalling when git changes bun.lock", () => {
  it("installs from the lockfile when it differs between the two revisions", () => {
    captureOutput();
    const { run, calls } = fakeRun(changed);
    expect(syncInstall(["abc", "def"], run)).toBe(0);
    expect(calls).toEqual([
      "git diff --quiet abc def -- bun.lock",
      "bun install --frozen-lockfile",
    ]);
  });

  it("does nothing when the lockfile is the same", () => {
    const { run, calls } = fakeRun();
    expect(syncInstall(["abc", "def"], run)).toBe(0);
    expect(calls).toEqual(["git diff --quiet abc def -- bun.lock"]);
  });

  it("does nothing when git can't compare the revisions", () => {
    const { run, calls } = fakeRun(() => ({ status: 128 }));
    expect(syncInstall(["abc", "gone"], run)).toBe(0);
    expect(calls).toEqual(["git diff --quiet abc gone -- bun.lock"]);
  });

  it("skips a fresh checkout, an unchanged head and missing revisions", () => {
    const { run, calls } = fakeRun(changed);
    expect(syncInstall(["0000000000000000000000000000000000000000", "def"], run)).toBe(0);
    expect(syncInstall(["abc", "abc"], run)).toBe(0);
    expect(syncInstall(["abc"], run)).toBe(0);
    expect(syncInstall([], run)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("warns without failing the hook when the install fails", () => {
    const output = captureOutput();
    const { run } = fakeRun((line) =>
      line.startsWith("bun install") ? { status: 1 } : changed(line),
    );
    expect(syncInstall(["abc", "def"], run)).toBe(0);
    expect(output()).toContain("run `bun install`");
  });
});
