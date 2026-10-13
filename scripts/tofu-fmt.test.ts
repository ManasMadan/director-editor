import { afterEach, describe, expect, it, mock } from "bun:test";
import { captureOutput, fakeRun } from "./stand-ins";
import { tofuFmt } from "./tofu-fmt";

afterEach(() => mock.restore());

describe("formatting the staged OpenTofu files", () => {
  it("runs tofu fmt on them", () => {
    const { run, calls } = fakeRun();
    expect(tofuFmt(["infra/main.tf"], run)).toBe(0);
    expect(calls).toEqual(["tofu version", "tofu fmt infra/main.tf"]);
  });

  it("fails when tofu fmt does", () => {
    const { run } = fakeRun((line) => (line.startsWith("tofu fmt") ? { status: 3 } : undefined));
    expect(tofuFmt(["a.tf"], run)).toBe(3);
    expect(
      tofuFmt(
        ["a.tf"],
        fakeRun((line) => (line.startsWith("tofu fmt") ? { status: null } : undefined)).run,
      ),
    ).toBe(1);
  });

  it("skips with a warning when OpenTofu isn't installed", () => {
    const output = captureOutput();
    const { run, calls } = fakeRun(() => ({ status: 1 }));
    expect(tofuFmt(["a.tf"], run)).toBe(0);
    expect(calls).toEqual(["tofu version"]);
    expect(output()).toContain("OpenTofu isn't installed");
  });
});
