import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { areas, areasOf, main } from "./changes";
import { ROOT } from "./lib";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

const none = { app: false, charts: false, infra: false, images: false, scripts: false };

describe("which CI jobs a pull request needs", () => {
  it("runs only the scripts' tests for docs, which some of them read", () => {
    expect(areas(["docs/deploy.md", "README.md", "deploy/README.md", "LICENSE"])).toEqual({
      ...none,
      scripts: true,
    });
  });

  it("runs the scripts' tests for every doc a test of theirs reads by name", () => {
    const tests = ["scripts", ".claude/hooks"].flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((file) => file.endsWith(".test.ts"))
        .map((file) => readFileSync(join(ROOT, dir, file), "utf8")),
    );
    const docs = new Set(
      tests.flatMap((text) => [...text.matchAll(/"([\w./-]+\.md)"/g)].map((m) => m[1] as string)),
    );
    const read = [...docs].filter((doc) => existsSync(join(ROOT, doc)));
    expect(read).toEqual(
      expect.arrayContaining([
        "docs/environment.md",
        "docs/deploy.md",
        "docs/repository-settings.md",
      ]),
    );
    expect(read.filter((doc) => !areasOf(doc).includes("scripts"))).toEqual([]);
  });

  it("runs the charts and the scripts' tests, not the app's, for a promotion", () => {
    expect(areas(["deploy/environments/production/release.yaml"])).toEqual({
      ...none,
      charts: true,
      scripts: true,
    });
  });

  it("runs OpenTofu's checks for infra/tofu", () => {
    expect(areasOf("infra/tofu/modules/k3s/main.tf")).toEqual(["infra", "scripts"]);
  });

  it("builds the images for a Dockerfile", () => {
    expect(areasOf("deploy/docker/web.Dockerfile")).toEqual(["images"]);
    expect(areasOf("deploy/docker/check-peers.mjs")).toEqual(["images", "scripts"]);
  });

  it("builds and starts the images for their smoke test", () => {
    expect(areasOf("scripts/image-smoke.ts")).toEqual(["images", "scripts"]);
  });

  it("runs the check a script is for, besides the scripts' own tests", () => {
    expect(areasOf("scripts/charts.ts")).toEqual(["charts", "scripts"]);
    expect(areasOf("scripts/secrets-check.ts")).toEqual(["charts", "scripts"]);
    expect(areasOf("scripts/infra.ts")).toEqual(["infra", "scripts"]);
    expect(areasOf("scripts/doctor.ts")).toEqual(["scripts"]);
  });

  it("checks both for what the bootstrap and charts:check share", () => {
    expect(areasOf("deploy/argocd/argo-cd-values.yaml")).toEqual(["charts", "infra", "scripts"]);
  });

  it("runs the app's for any source change", () => {
    expect(areasOf("apps/api/src/main.ts")).toEqual(["app"]);
    expect(areasOf("packages/ui/src/button.tsx")).toEqual(["app"]);
  });

  it("checks the Claude setup's own markdown", () => {
    expect(areasOf(".claude/skills/release/SKILL.md")).toEqual(["scripts"]);
  });

  it("runs everything when CI, the toolchain or the lockfile change", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      "bun.lock",
      "package.json",
      "scripts/changes.ts",
    ]) {
      expect(areas([file])).toEqual({
        app: true,
        charts: true,
        infra: true,
        images: true,
        scripts: true,
      });
    }
  });
});

describe("the command", () => {
  it("prints each area for the files changed since the base, or all of them without one", () => {
    const printed = captureOutput();
    const { run, calls } = fakeRun(() => ({ stdout: "docs/testing.md\n" }));
    expect(main("origin/master", run)).toBe(0);
    expect(calls).toEqual(["git diff --name-only origin/master HEAD"]);
    expect(printed()).toContain("app=false");
    expect(main(undefined, run)).toBe(0);
    expect(printed()).toContain("app=true");
  });

  it("fails when git can't diff against the base", () => {
    const printed = captureOutput();
    expect(main("nowhere", fakeRun(() => ({ status: 128, stderr: "bad revision" })).run)).toBe(1);
    expect(printed()).toContain("git diff against nowhere failed: bad revision");
  });
});
