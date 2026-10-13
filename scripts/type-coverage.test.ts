import { afterEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";
import { captureOutput, fakeRun } from "./stand-ins";
import { check, main, workspaces } from "./type-coverage";

afterEach(() => mock.restore());

describe("type coverage", () => {
  it("covers every workspace with a tsconfig, and none without", () => {
    const found = workspaces(join(import.meta.dir, ".."));
    expect(found).toContain("apps/api");
    expect(found).toContain("packages/nest-common");
    expect(found).toEqual(expect.arrayContaining(["scripts", "load", "turbo/generators"]));
    expect(found).not.toContain("apps/ai");
    expect(found).not.toContain("packages/typescript-config");
  });

  it("asks for 100% in strict mode outside tests and generated code, and names what falls short", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun((line) =>
      line.includes("apps/web/")
        ? { status: 1, stdout: "apps/web/src/page.tsx:3:7: data\n" }
        : undefined,
    );
    expect(check(["apps/api", "apps/web"], run)).toEqual(["apps/web"]);
    expect(calls[0]).toContain("-p apps/api/tsconfig.json --strict --at-least 100");
    expect(calls[0]).toContain("--ignore-files **/*.test.ts");
    expect(calls[0]).toContain("--ignore-files **/generated/**");
    expect(printed()).toContain("apps/web/src/page.tsx:3:7: data");
  });

  it("checks what it's given, or every workspace, and fails if any falls short", () => {
    captureOutput();
    const passing = fakeRun();
    expect(main(["apps/api"], passing.run)).toBe(0);
    expect(passing.calls).toHaveLength(1);
    const failing = fakeRun(() => ({ status: 1 }));
    expect(main([], failing.run)).toBe(1);
    expect(failing.calls.length).toBeGreaterThan(10);
  });
});
