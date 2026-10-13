import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./lib";
import { STEPS } from "./lint";
import { isShellScript, LINTERS, lint, renovateVersion } from "./linters";
import { captureOutput, fakeRun } from "./stand-ins";

afterEach(() => mock.restore());

/** A checkout with these files, and a `git ls-files` that lists them and one deleted. */
function checkout(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "linters-"));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  const listed = { stdout: [...files, "deleted.yml"].join("\0") };
  return { root, listed };
}

const { actionlint, zizmor, hadolint, tflint, renovate } = LINTERS;

describe("the pinned linters", () => {
  it("run a local binary of the pinned version over the files they read, and fail as it does", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml", "README.md"]);
    const { run, calls } = fakeRun((line) => {
      if (line.startsWith("git ls-files")) {
        return listed;
      }
      if (line === "actionlint --version") {
        return { stdout: `${actionlint.version}\ninstalled from Homebrew\n` };
      }
      return line.startsWith("actionlint .github") ? { status: 1 } : {};
    });
    expect(lint(["actionlint"], run, root)).toBe(1);
    expect(calls).toEqual([
      "git ls-files --cached --others --exclude-standard -z",
      "actionlint --version",
      "actionlint .github/workflows/ci.yml",
    ]);
  });

  it("run the pinned image when the local binary is another version, or missing", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml", ".github/zizmor.yml"]);
    for (const local of [{ stdout: "zizmor 0.1.0\n" }, { status: null }]) {
      const { run, calls } = fakeRun((line) => {
        if (line.startsWith("git ls-files")) {
          return listed;
        }
        return line === "zizmor --version" ? local : {};
      });
      expect(lint(["zizmor"], run, root)).toBe(0);
      expect(calls.at(-1)).toBe(
        `docker run --rm --memory=512m -v ${root}:${root}:ro -w ${root} --entrypoint zizmor ghcr.io/zizmorcore/zizmor:${zizmor.version} --offline --config=.github/zizmor.yml .github`,
      );
    }
  });

  it("fail rather than skipping when there's neither, or the linter can't start", () => {
    const { root, listed } = checkout([".github/workflows/ci.yml"]);
    const printed = captureOutput();
    const neither = fakeRun((line) => (line.startsWith("git ls-files") ? listed : { status: 1 }));
    expect(lint(["actionlint"], neither.run, root)).toBe(1);
    expect(printed()).toContain(
      `actionlint ${actionlint.version} isn't installed and Docker isn't running`,
    );
    const broken = fakeRun((line) => {
      if (line.startsWith("git ls-files")) {
        return listed;
      }
      return line.startsWith("docker run") ? { status: null } : {};
    });
    expect(lint(["actionlint"], broken.run, root)).toBe(1);
  });

  it("pass with nothing to check, and name the linters when given another", () => {
    const printed = captureOutput();
    const { root, listed } = checkout(["README.md"]);
    const { run, calls } = fakeRun(() => listed);
    expect(lint(["actionlint"], run, root)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lint(["eslint"], run, root)).toBe(1);
    expect(printed()).toContain(`One of ${Object.keys(LINTERS).join(", ")}.`);
  });

  it("refuse any Renovate config but renovate.json5, which Renovate would read first", () => {
    const printed = captureOutput();
    const { root, listed } = checkout(["renovate.json5", "renovate.json"]);
    const { run, calls } = fakeRun(() => listed);
    expect(lint(["renovate"], run, root)).toBe(1);
    expect(printed()).toContain("it would read renovate.json first: delete it");
    expect(calls).toHaveLength(1);
  });

  it("validate Renovate's config with its validator, at the version renovate.yml runs", () => {
    const { root, listed } = checkout(["renovate.json5", ".github/workflows/renovate.yml"]);
    writeFileSync(
      join(root, ".github/workflows/renovate.yml"),
      "steps:\n  - uses: renovatebot/github-action@abc # v1\n    with:\n      renovate-version: 43.2.1\n",
    );
    expect(renovateVersion(root)).toBe("43.2.1");
    expect(renovate.version).toBe(renovateVersion());
    expect(renovate.version).toMatch(/^\d+\.\d+\.\d+$/);
    const image = `docker run --rm --memory=512m -v ${root}:${root}:ro -w ${root} --entrypoint renovate-config-validator renovate/renovate:${renovate.version} --strict`;
    const cases: [string, string][] = [
      [`${renovate.version}\n`, "renovate-config-validator --strict"],
      ["40.0.0\n", image],
    ];
    for (const [version, expected] of cases) {
      const { run, calls } = fakeRun((line) => {
        if (line.startsWith("git ls-files")) {
          return listed;
        }
        return line === "renovate-config-validator --version" ? { stdout: version } : {};
      });
      expect(lint(["renovate"], run, root)).toBe(0);
      expect(calls.at(-1)).toBe(expected);
    }
  });

  it("read what each checks", () => {
    expect(actionlint.reads(".github/workflows/ci.yml", ROOT)).toBe(true);
    expect(actionlint.reads(".github/actions/setup/action.yml", ROOT)).toBe(false);
    expect(zizmor.reads(".github/actions/setup/action.yml", ROOT)).toBe(true);
    expect(zizmor.reads("deploy/charts/stack/values.yaml", ROOT)).toBe(false);
    for (const path of [".devcontainer/Dockerfile", "deploy/docker/web.Dockerfile"]) {
      expect(hadolint.reads(path, ROOT)).toBe(true);
    }
    expect(hadolint.reads("scripts/dockerfiles.test.ts", ROOT)).toBe(false);
    expect(tflint.reads("infra/tofu/modules/k3s/main.tf", ROOT)).toBe(true);
    expect(tflint.reads("infra/tofu/README.md", ROOT)).toBe(false);
    expect(renovate.reads("renovate.json5", ROOT)).toBe(true);
    expect(renovate.reads("apps/web/renovate.json5", ROOT)).toBe(false);
  });

  it("find every shell script: by its extension, as a git hook, or by its first line", () => {
    const { root } = checkout([".husky/pre-commit"]);
    const scripts: Record<string, string> = {
      "bin/deploy": "#!/usr/bin/env bash\nset -e\n",
      "bin/posix": "#!/bin/sh\n",
      "bin/tool": "#!/usr/bin/env bun\n",
      LICENSE: "MIT\n",
    };
    for (const [path, text] of Object.entries(scripts)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const shell = (path: string) => isShellScript(path, root);
    expect(["a/x.sh", "b.bash", ".husky/pre-commit", "bin/deploy", "bin/posix"].every(shell)).toBe(
      true,
    );
    expect([".husky/.shellcheckrc", "bin/tool", "LICENSE", "bin/gone", "a/x.ts"].some(shell)).toBe(
      false,
    );
  });

  it("give shellcheck and hadolint the files, tflint its configuration by its full path", () => {
    expect(LINTERS.shellcheck.args(["a.sh"], "/repo")).toEqual(["a.sh"]);
    expect(hadolint.args(["Dockerfile"], "/repo")).toEqual(["Dockerfile"]);
    // Every module reads it, and tflint would look for it in each module's own folder.
    expect(tflint.args([], "/repo")).toContain("--config=/repo/infra/tofu/.tflint.hcl");
  });

  it("are each a `bun run lint:<name>` script, and a step of `bun run lint`", () => {
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const steps = STEPS.map((step) => step.join(" "));
    for (const name of Object.keys(LINTERS)) {
      expect(scripts[`lint:${name}`]).toBe(`bun scripts/linters.ts ${name}`);
      expect(steps).toContain(`bun run lint:${name}`);
    }
  });
});
