/**
 * Toolchain pins: the same version wherever one tool is pinned twice, and every version
 * pinned in a workflow, an action or a script within Renovate's reach (renovate.json5),
 * so none of them stays behind unnoticed.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("a tool pinned in two places", () => {
  it("is the same Node in .nvmrc (CI) and eas.json (EAS's builds), to the patch", () => {
    const eas = JSON.parse(read("apps/mobile/eas.json")) as { build: { base: { node: string } } };
    expect(read(".nvmrc").trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read(".nvmrc").trim()).toBe(eas.build.base.node);
  });

  it("is the same uv in CI's setup action and the devcontainer", () => {
    const setup = /astral-sh\/setup-uv@[\s\S]*?\n\s+version: (\S+)/.exec(
      read(".github/actions/setup/action.yml"),
    )?.[1];
    const devcontainer = /ghcr\.io\/astral-sh\/uv:([^@\s]+)/.exec(
      read(".devcontainer/Dockerfile"),
    )?.[1];
    expect(setup).toMatch(/^\d+\.\d+\.\d+$/);
    expect(setup).toBe(devcontainer);
  });
});

/**
 * `with:` inputs Renovate's github-actions manager reads by itself (its docs' table of
 * actions): a `# renovate:` comment there would make a second, competing update.
 */
const NATIVE: Record<string, string> = {
  "astral-sh/setup-uv": "version",
  "azure/setup-helm": "version",
  "expo/expo-github-action": "eas-version",
  "opentofu/setup-opentofu": "tofu_version",
  "renovatebot/github-action": "renovate-version",
};

/** The files a pin may be in, each with its text. */
function files() {
  const list = (dir: string, pattern: RegExp) =>
    readdirSync(join(ROOT, dir), { recursive: true })
      .map(String)
      .filter((file) => pattern.test(file))
      .map((file) => join(dir, file));
  return [
    ...list(".github/workflows", /\.ya?ml$/),
    ...list(".github/actions", /action\.ya?ml$/),
    ...list("scripts", /^[^/]+\.ts$/).filter((file) => !file.endsWith(".test.ts")),
  ].map((path) => ({ path, lines: read(path).split("\n") }));
}

const VERSION = String.raw`v?\d+\.\d+(?:\.\d+)?(?![.\d])`;
/** A package at a version (`name@1.2.3`, `name==1.2.3`), or a `*version` key's value. */
const PIN = new RegExp(
  String.raw`[\w.-]+(?:@|==)${VERSION}|\b[\w-]*version["']?\s*:\s*["']?${VERSION}`,
  "i",
);

/** The step a workflow line belongs to: its lines back to the one starting it. */
function stepOf(lines: string[], index: number) {
  let start = index;
  while (start > 0 && !/^\s*- /.test(lines[start] ?? "")) {
    start--;
  }
  return lines.slice(start, index + 1).join("\n");
}

/** renovate.json5's manager for `# renovate:` comments: its files, and its pattern. */
function markerManager() {
  const config = read("renovate.json5");
  const block = config.slice(config.indexOf("Versions marked with a `# renovate:`"));
  const files = /managerFilePatterns: \[\n([\s\S]*?)\n\s*\],/.exec(block)?.[1] ?? "";
  const patterns = [...files.matchAll(/"\/(.+)\/",?$/gm)].map(
    ([, source]) => new RegExp(String(JSON.parse(`"${source}"`))),
  );
  const match = /matchStrings: \[\s*("[^\n]*"),?\s*\]/.exec(block)?.[1] ?? '""';
  return { patterns, match: new RegExp(String(JSON.parse(match)), "g") };
}

describe("every pinned version", () => {
  const all = files();
  const pins = all.flatMap(({ path, lines }) =>
    lines.flatMap((line, index) => {
      const comment = /^\s*(#|\/\/|\*)/.test(line);
      if (comment || /^\s*(- )?uses: /.test(line) || !PIN.test(line)) {
        return [];
      }
      return [{ path, line: line.trim(), index, lines }];
    }),
  );

  it("is found where they're written", () => {
    const names = pins.map((pin) => `${pin.path}: ${pin.line}`);
    for (const pin of ["diff-cover@", "squawk-cli@", "postgres-mcp@", "mcp==", "eas-version:"]) {
      expect(names.some((name) => name.includes(pin))).toBe(true);
    }
  });

  it("has a `renovate:` comment above it, or is an input Renovate reads by itself", () => {
    const unmarked = pins
      .filter(({ lines, index }) => !/(#|\/\/) renovate: datasource=/.test(lines[index - 1] ?? ""))
      .filter(({ lines, index, line }) => {
        const step = stepOf(lines, index);
        return !Object.entries(NATIVE).some(
          ([action, input]) => step.includes(`uses: ${action}@`) && line.includes(`${input}:`),
        );
      })
      .map(({ path, line }) => `${path}: ${line}`);
    expect(unmarked).toEqual([]);
  });

  it("is in a file Renovate reads its comments in, which its pattern picks up", () => {
    const { patterns, match } = markerManager();
    expect(patterns.length).toBeGreaterThan(0);
    for (const { path, lines, index, line } of pins) {
      if (!/renovate: datasource=/.test(lines[index - 1] ?? "")) {
        continue;
      }
      expect({ path, read: patterns.some((pattern) => pattern.test(path)) }).toEqual({
        path,
        read: true,
      });
      const text = `${lines[index - 1]}\n${lines[index]}\n`;
      const found = [...text.matchAll(match)].map((m) => m.groups?.currentValue);
      const version = new RegExp(VERSION).exec(line.replace(/^.*?(?:@|==|:\s*["']?)(?=v?\d)/, ""));
      expect({ path, found }).toEqual({ path, found: [version?.[0]] });
    }
  });
});

describe("the Playwright image", () => {
  // packages/ui's test:visual runs the installed @playwright/test in it: the screenshot
  // baselines depend on that exact browser build, so image and packages move together
  // (renovate.json5's "playwright" group).
  const { version: installed } = JSON.parse(read("node_modules/@playwright/test/package.json")) as {
    version: string;
  };
  const tags = Bun.spawnSync(
    ["git", "grep", "-oE", String.raw`mcr\.microsoft\.com/playwright:[^ "]+`],
    {
      cwd: ROOT,
    },
  )
    .stdout.toString()
    .trim()
    .split("\n");

  it("is tagged with the installed Playwright version wherever it's named", () => {
    expect(tags.length).toBeGreaterThan(1);
    // `<file>:<image>:<tag>`
    expect(new Set(tags.map((tag) => tag.split(":").at(-1)))).toEqual(
      new Set([`v${installed}-noble`]),
    );
  });

  it("is the version every package declares Playwright at", () => {
    type Deps = Record<string, string> | undefined;
    const files = ["", "apps/web/", "apps/mobile/", "packages/ui/"].map(
      (dir) => `${dir}package.json`,
    );
    const manifests = files.map(
      (file) =>
        JSON.parse(read(file)) as {
          dependencies?: Deps;
          devDependencies?: Deps;
          workspaces?: { catalog?: Deps };
        },
    );
    const declared = manifests.flatMap((manifest) =>
      [manifest.dependencies, manifest.devDependencies, manifest.workspaces?.catalog].flatMap(
        (deps) =>
          ["@playwright/test", "playwright", "playwright-core"].flatMap((name) =>
            deps?.[name] ? [deps[name]] : [],
          ),
      ),
    );
    expect(declared.length).toBeGreaterThan(2);
    expect(new Set(declared)).toEqual(new Set([installed]));
  });

  it("is found by Renovate's manager for the images the scripts run", () => {
    const config = read("renovate.json5");
    const block = config.slice(config.indexOf("Images the scripts run with `docker run`"));
    const match = /matchStrings: \[\s*("[^\n]*"),?\s*\]/.exec(block)?.[1] ?? '""';
    const pattern = new RegExp(String(JSON.parse(match)), "g");
    for (const file of tags.map((tag) => tag.slice(0, tag.indexOf(":")))) {
      const found = [...read(file).matchAll(pattern)].map((m) => m.groups?.depName);
      expect({ file, found: found.includes("mcr.microsoft.com/playwright") }).toEqual({
        file,
        found: true,
      });
    }
  });
});
