/**
 * The end-to-end suites retry in CI only to tell a flaky test from a broken one: a test
 * that passed only on a retry still fails the run, or retries would hide it.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const manifest = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

const configs = ["apps/web/playwright.config.ts", "apps/mobile/playwright.config.ts"];

describe("the Playwright suites", () => {
  it.each(configs)("%s fails the run on a flaky test in CI", (file) => {
    const config = readFileSync(join(ROOT, file), "utf8");
    expect(config).toContain("failOnFlakyTests: Boolean(process.env.CI)");
  });
});

// Claude Code drives a browser with Playwright's CLI and reads traces through Playwright's
// official skills, installed into .claude/skills by its own commands. Both come from the
// root's playwright-core, which has to be the e2e suites' version (and so use their
// browsers), and the committed skills have to be that version's: Renovate's Playwright
// updates reinstall them, with the commands its workflow allows and nothing else.
describe("the Playwright CLI", () => {
  const root = manifest("package.json");
  const PLAYWRIGHT_SKILLS = ["playwright-cli", "playwright-trace"];
  const files = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();

  const renovate = readFileSync(join(ROOT, "renovate.json5"), "utf8");
  const group = renovate.slice(
    renovate.indexOf('description: "Playwright:'),
    renovate.indexOf("\n    },", renovate.indexOf('description: "Playwright:')),
  );
  const list = (text: string, key: string) =>
    JSON.parse(new RegExp(`${key}: (\\[.*?\\])`).exec(text)?.[1] ?? "[]") as string[];
  /** What the Playwright group runs after an update, but the `bun install` before it. */
  const refresh = list(group, "commands").filter((command) => command !== "bun install");
  const fix = `Reinstall Playwright's skills: ${refresh.join(" && ")}`;

  it("is the version the e2e suites run", () => {
    expect(root.devDependencies["playwright-core"]).toBe(
      manifest("apps/web/package.json").devDependencies["@playwright/test"],
    );
  });

  it.each(PLAYWRIGHT_SKILLS)("comes with the installed version's %s skill", (skill) => {
    const installed = join(ROOT, "node_modules/playwright-core/lib/tools/skills", skill);
    const committed = join(ROOT, ".claude/skills", skill);
    expect(files(committed), fix).toEqual(files(installed));
    for (const file of files(installed)) {
      expect(readFileSync(join(committed, file), "utf8"), `${file}: ${fix}`).toBe(
        readFileSync(join(installed, file), "utf8"),
      );
    }
  });

  it("has its skills reinstalled by Renovate's Playwright updates", () => {
    const packages = [
      "package.json",
      "apps/web/package.json",
      "apps/mobile/package.json",
      "packages/ui/package.json",
    ]
      .flatMap((path) => Object.keys(manifest(path).devDependencies))
      .filter((name) => /^(@playwright\/|playwright)/.test(name));
    // Plus the image packages/ui's visual tests run Playwright in (scripts/pins.test.ts).
    expect(list(group, "matchPackageNames").sort()).toEqual(
      [...new Set(packages), "mcr.microsoft.com/playwright"].sort(),
    );
    expect(group).toContain('groupName: "playwright"');
    expect(list(group, "commands")).toEqual([
      "bun install",
      "rm -rf .claude/skills/playwright-*",
      "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 .claude/bin/playwright-cli install --skills",
      "bunx playwright trace install-skill",
    ]);
    expect(list(group, "fileFilters")).toEqual([".claude/skills/playwright-*/**"]);
  });

  it("lets Renovate run exactly the commands its configuration runs", () => {
    const workflow = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/renovate.yml"), "utf8"),
    ) as { jobs: { renovate: { steps: { env?: Record<string, string> }[] } } };
    const allowed = workflow.jobs.renovate.steps
      .flatMap((step) => JSON.parse(step.env?.RENOVATE_ALLOWED_COMMANDS ?? "[]") as string[])
      .map((pattern) => new RegExp(pattern));
    const commands = [...renovate.matchAll(/commands: (\[.*?\])/g)].flatMap(
      (match) => JSON.parse(match[1] ?? "[]") as string[],
    );
    expect(commands.filter((command) => !allowed.some((regex) => regex.test(command)))).toEqual([]);
    expect(allowed.filter((regex) => !commands.some((command) => regex.test(command)))).toEqual([]);
    for (const regex of allowed) {
      expect(regex.source).toStartWith("^");
      expect(regex.source).toEndWith("$");
    }
  });

  it("changes nothing when the skills are already the installed version's", () => {
    const tree = mkdtempSync(join(tmpdir(), "playwright-skills-"));
    cpSync(join(ROOT, ".claude/bin"), join(tree, ".claude/bin"), { recursive: true });
    for (const skill of PLAYWRIGHT_SKILLS) {
      cpSync(join(ROOT, ".claude/skills", skill), join(tree, ".claude/skills", skill), {
        recursive: true,
      });
    }
    cpSync(join(ROOT, ".gitignore"), join(tree, ".gitignore"));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    const sh = (command: string) => {
      const run = Bun.spawnSync(["sh", "-c", command], { cwd: tree, stderr: "pipe" });
      expect(run.exitCode, `${command}: ${run.stderr.toString()}`).toBe(0);
      return run.stdout.toString();
    };
    sh("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm tree");
    for (const command of refresh) {
      sh(command);
    }
    expect(sh("git status --porcelain")).toBe("");
    expect(readdirSync(join(tree, ".playwright"))).toEqual([]);
  }, 30_000);
});
