import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { captureOutput } from "./stand-ins";
import {
  addedSuppressions,
  checkSuppressions,
  countSuppressions,
  EXCEPTION_SECTIONS,
  exceptionRows,
  unallowed,
} from "./suppressions";

const SKIPPED =
  "a skipped test (.skip, .skipIf, .runIf, .todo, .fixme, .fail, xit, pytest's skip and xfail)";

afterEach(() => mock.restore());

describe("suppressions", () => {
  it.each([
    ["// @ts-ignore", "@ts-ignore"],
    ["// @ts-expect-error untyped", "@ts-expect-error"],
    ["// biome-ignore lint/x: y", "biome-ignore"],
    ["/* v8 ignore next */", "coverage ignore (v8, c8, istanbul)"],
    ["x = 1  # pragma: no cover", "# pragma: no cover"],
    ["x = f()  # type: ignore[attr]", "# type: ignore"],
    ["x = f()  # pyright: ignore[reportAny]", "# pyright: ignore"],
    ["import os  # noqa: F401", "# noqa"],
    ["// type-coverage:ignore-next-line", "type-coverage:ignore"],
    ["log = cast(Logger, get_logger())", "typing.cast()"],
    ["it.skip('x', () => {})", SKIPPED],
    ["test.skipIf(!env)('x', () => {})", SKIPPED],
    ["it.runIf(env)('x', () => {})", SKIPPED],
    ["it.todo('x')", SKIPPED],
    ["test.fixme('x', async () => {})", SKIPPED],
    ["test.fail('x', async () => {})", SKIPPED],
    ["test.fails('x', () => {})", SKIPPED],
    ["it('x', (ctx) => { ctx.skip(); })", SKIPPED],
    ["xit('x', () => {})", SKIPPED],
    ["@pytest.mark.skip(reason='x')", SKIPPED],
    ["@pytest.mark.skipif(True, reason='x')", SKIPPED],
    ["@pytest.mark.xfail", SKIPPED],
    ["    pytest.skip('no key')", SKIPPED],
    ["    pytest.xfail('known')", SKIPPED],
    ["describe.only('x', () => {})", "a focused test (.only, fit)"],
    ["-- squawk-ignore ban-drop-column", "-- squawk-ignore"],
    ["# shellcheck disable=SC2016", "# shellcheck disable"],
    ["# hadolint ignore=DL3008", "# hadolint ignore"],
    ["on: # zizmor: ignore[dangerous-triggers]", "# zizmor: ignore"],
    ["# tflint-ignore: terraform_unused_declarations", "# tflint-ignore"],
  ])("%s", (text, kind) => {
    expect([...countSuppressions(text).keys()]).toEqual([kind]);
  });

  it.each([
    ["biome.jsonc", '"style": { "noNonNullAssertion": "off" }', "noNonNullAssertion"],
    ["biome.jsonc", '"a11y": { "useAltText": { "level": "warn" } }', "useAltText"],
    ["biome.jsonc", '"a11y": "info"', "a11y"],
    [".github/zizmor.yml", "rules:\n  self-repository:\n    disable: true\n", "self-repository"],
    [
      ".github/zizmor.yml",
      "rules:\n  artipacked:\n    config: {}\n    ignore:\n      - ci.yml\n",
      "artipacked",
    ],
    [".husky/.shellcheckrc", "shell=sh\ndisable=SC2034\n", "SC2034"],
    [
      "infra/tofu/.tflint.hcl",
      'rule "terraform_naming_convention" {\n  enabled = false\n}',
      "terraform_naming_convention",
    ],
  ])("a rule %s turns off", (path, text, rule) => {
    expect([...countSuppressions(text, path).keys()]).toEqual([`${rule} off in ${path}`]);
  });

  it("reads a linter's configuration for its rules only, not the suppressions its comments name", () => {
    const text = '// a fix that turns @ts-ignore into @ts-expect-error\n"noTsIgnore": "error"';
    expect(countSuppressions(text, "biome.jsonc")).toEqual(new Map());
    expect(countSuppressions('"level": "error", "x": "on"', "biome.jsonc")).toEqual(new Map());
  });

  it("ignores ordinary code", () => {
    expect(
      countSuppressions("const skip = items.skip; export function only() {} broadcast(x);"),
    ).toEqual(new Map());
  });

  it("reports only what an edit adds", () => {
    const before = "a // @ts-expect-error old\n";
    expect(addedSuppressions(before, `${before}b\n`)).toEqual([]);
    expect(addedSuppressions(before, `${before}c // @ts-expect-error new\n`)).toEqual([
      "@ts-expect-error",
    ]);
    expect(addedSuppressions(before, "a\n")).toEqual([]);
    const rules = '"a": "off",\n';
    expect(addedSuppressions(rules, `${rules}"b": "off",\n`, "biome.jsonc")).toEqual([
      "b off in biome.jsonc",
    ]);
    expect(addedSuppressions(rules, `${rules}${rules}`, "biome.jsonc")).toEqual([
      "a off in biome.jsonc",
    ]);
  });

  it("reads the rows of docs/testing.md's exceptions tables, and the files each names", () => {
    const root = mkdtempSync(join(tmpdir(), "suppressions-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs/testing.md"),
      [
        "## Coverage exceptions",
        "Prose `apps/x.ts` isn't a row.",
        "| File | Why |",
        "|---|---|",
        "| `apps/notifications/test/fake-push.ts:25` | untyped module |",
        "## Suppressions",
        "| `.devcontainer/Dockerfile` | `# hadolint ignore=DL3066` | `Field` is named, not a file |",
        "## Not tested automatically",
        "| `apps/y.test.ts` | a table that allows nothing |",
      ].join("\n"),
    );
    expect(exceptionRows(root).map(({ section, files }) => [section, files])).toEqual([
      ["## Coverage exceptions", []],
      ["## Coverage exceptions", []],
      ["## Coverage exceptions", ["apps/notifications/test/fake-push.ts"]],
      ["## Suppressions", [".devcontainer/Dockerfile"]],
    ]);
    expect(exceptionRows(mkdtempSync(join(tmpdir(), "none-")))).toEqual([]);
  });

  describe("allows a kind in a file only through a row for both", () => {
    const row = (section: string, file: string, text = "") => ({
      section: section as "## Suppressions",
      files: [file],
      text: `| \`${file}\` | ${text} |`,
    });
    const skip = "test.skip(!process.env.KEY);\n";
    const ignore = "// biome-ignore lint/style/noNonNullAssertion: x\n";

    it("a skipped test, under Skipped tests, and nothing else there", () => {
      const rows = [row("## Skipped tests", "a.spec.ts")];
      expect(unallowed(rows, "a.spec.ts", skip)).toEqual([]);
      expect(unallowed(rows, "a.spec.ts", `${skip}${ignore}`)).toEqual(["biome-ignore"]);
      expect(unallowed(rows, "b.spec.ts", skip)).toEqual([SKIPPED]);
    });

    it("a suppression, under Suppressions, by a row that names it", () => {
      const rows = [row("## Suppressions", "a.ts", "`biome-ignore lint/style/x`")];
      expect(unallowed(rows, "a.ts", ignore)).toEqual([]);
      expect(unallowed(rows, "a.ts", `${ignore}// @ts-expect-error\n`)).toEqual([
        "@ts-expect-error",
      ]);
      expect(unallowed(rows, "a.ts", skip)).toEqual([SKIPPED]);
    });

    it("a rule a configuration turns off, by a row that names the rule", () => {
      const rows = [row("## Suppressions", "biome.jsonc", "`noConsole` off in scripts")];
      expect(unallowed(rows, "biome.jsonc", '"noConsole": "off"')).toEqual([]);
      expect(unallowed(rows, "biome.jsonc", '"noExplicitAny": "off"')).toEqual([
        "noExplicitAny off in biome.jsonc",
      ]);
    });

    it("a focused test, never", () => {
      const rows = EXCEPTION_SECTIONS.map((section) => row(section, "a.test.ts", "fit"));
      expect(unallowed(rows, "a.test.ts", "fit('x', () => {});")).toEqual([
        "a focused test (.only, fit)",
      ]);
    });
  });
});

describe("the check over the repository's files", () => {
  it("fails on an unlisted suppression, and passes once docs/testing.md lists the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "suppressions-"));
    await $`git init -q`.cwd(root);
    mkdirSync(join(root, "apps"));
    writeFileSync(join(root, "apps/x.ts"), "// @ts-expect-error untyped\n");
    writeFileSync(join(root, "apps/clean.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "notes.md"), "// @ts-expect-error in prose\n");
    await $`git add .`.cwd(root);
    const printed = captureOutput();
    expect(checkSuppressions(root)).toBe(1);
    expect(printed()).toContain("apps/x.ts: @ts-expect-error");
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs/testing.md"),
      "## Suppressions\n| `apps/x.ts` | `@ts-expect-error` | untyped |\n",
    );
    expect(checkSuppressions(root)).toBe(0);
    // A new file counts before it's added, and a deleted one is skipped.
    writeFileSync(join(root, "apps/new.ts"), "// @ts-expect-error new\n");
    rmSync(join(root, "apps/clean.ts"));
    expect(checkSuppressions(root)).toBe(1);
    expect(printed()).toContain("apps/new.ts: @ts-expect-error");
  });

  it("reads migrations, workflows, shell scripts, Dockerfiles, OpenTofu and Biome's rules", async () => {
    const root = mkdtempSync(join(tmpdir(), "suppressions-"));
    await $`git init -q`.cwd(root);
    const files: Record<string, string> = {
      "packages/db/prisma/migrations/1_x/migration.sql": "-- squawk-ignore ban-drop-column\n",
      ".github/workflows/ci.yml": "# shellcheck disable=SC2016\n",
      ".husky/pre-commit": "# shellcheck disable=SC2086\n",
      "deploy/charts/data/files/x.sh": "# shellcheck disable=SC2086\n",
      ".devcontainer/Dockerfile": "# hadolint ignore=DL3066\n",
      "infra/tofu/main.tf": "# tflint-ignore: terraform_unused_declarations\n",
      "biome.jsonc": '{ "noConsole": "off" }\n',
      "README.md": "-- squawk-ignore in prose\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const printed = captureOutput();
    expect(checkSuppressions(root)).toBe(1);
    const reported = Object.keys(files).filter((path) => printed().includes(`${path}:`));
    expect(reported).toEqual(Object.keys(files).filter((path) => path !== "README.md"));
  });
});
