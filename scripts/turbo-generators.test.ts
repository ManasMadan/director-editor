/**
 * The code generators' own logic (turbo/generators/config.ts): their questions, the event
 * labels they write and the commands they run. scripts/generators.ts runs them for real.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlopTypes } from "@turbo/gen";
import generator, { setUp } from "../turbo/generators/config";

/** Plop's case helpers, enough of them for kebab-case input. */
const HELPERS: Record<string, (value: string) => string> = {
  kebabCase: (value) => value,
  camelCase: (value) => value.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()),
  snakeCase: (value) => value.replaceAll("-", "_"),
  sentenceCase: (value) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " "),
  lowerCase: (value) => value.toLowerCase(),
};

/** The generators set up on a fake plop whose destination is `root`, and the commands run. */
function generators(root = mkdtempSync(join(tmpdir(), "generators-"))) {
  const set: Record<string, Partial<PlopTypes.PlopGeneratorConfig>> = {};
  const plop = {
    getDestBasePath: () => root,
    setGenerator: (name: string, config: Partial<PlopTypes.PlopGeneratorConfig>) => {
      set[name] = config;
    },
    getHelper: (name: string) => HELPERS[name],
  } as unknown as PlopTypes.NodePlopAPI;
  const ran: string[] = [];
  setUp(plop, (command, args) => ran.push([command, ...args].join(" ")));
  const prompt = (generator: string, name: string) => {
    const prompts = set[generator]?.prompts as PlopTypes.PromptQuestion[];
    return prompts.find((question) => question.name === name) as {
      validate: (value: string) => true | string;
      default?: string | ((answers: PlopTypes.Answers) => string);
    };
  };
  const actions = (name: string) =>
    ((set[name]?.actions ?? []) as unknown[]).filter(
      (action): action is PlopTypes.CustomActionFunction => typeof action === "function",
    );
  const act = (action: PlopTypes.CustomActionFunction | undefined, answers: object) =>
    action?.(answers, {} as never, plop);
  return { root, plop, ran, prompt, actions, act };
}

describe("the api-feature generator", () => {
  it("asks for a new kebab-case feature, its item, its model and a test row", () => {
    const root = mkdtempSync(join(tmpdir(), "generators-"));
    mkdirSync(join(root, "apps/api/src/modules/projects"), { recursive: true });
    const { prompt } = generators(root);
    const name = prompt("api-feature", "name");
    expect(name.validate("Projects")).toContain("kebab-case");
    expect(name.validate("projects")).toBe("projects exists");
    expect(name.validate("time-entries")).toBe(true);

    const item = prompt("api-feature", "item");
    expect(typeof item.default === "function" && item.default({ name: "time-entries" })).toBe(
      "time-entrie",
    );
    expect(item.validate("time_entry")).toContain("kebab-case");
    expect(item.validate("time-entry")).toBe(true);

    const model = prompt("api-feature", "model");
    expect(typeof model.default === "function" && model.default({ item: "time-entry" })).toBe(
      "timeEntry",
    );
    expect(model.validate("time-entry")).toContain("camelCase");
    expect(model.validate("timeEntry")).toBe(true);

    const row = prompt("api-feature", "row");
    expect(row.validate('{"name": "Launch"}')).toBe(true);
    expect(row.validate("[1]")).toBe("A JSON object");
    expect(row.validate("{")).toContain("A JSON object");
  });

  it("describes the deletion event in every language, and formats what it touched", () => {
    const { root, ran, actions, act } = generators();
    mkdirSync(join(root, "packages/i18n/messages"), { recursive: true });
    for (const locale of ["en", "es"]) {
      writeFileSync(
        join(root, `packages/i18n/messages/${locale}.json`),
        JSON.stringify({ common: {}, workspace: { audit: { events: {} } } }),
      );
    }
    const [describe, format] = actions("api-feature");
    expect(act(describe, { item: "time-entry" })).toBe("described its event in the audit log");
    expect(act(describe, { item: "invoice" })).toBe("described its event in the audit log");
    const en = JSON.parse(readFileSync(join(root, "packages/i18n/messages/en.json"), "utf8")) as {
      workspace: { audit: { events: object } };
    };
    expect(Object.keys(en)).toEqual(["common", "workspace"]);
    expect(en.workspace.audit.events).toEqual({
      time_entry: { deleted: { v1: "Deleted a time entry" } },
      invoice: { deleted: { v1: "Deleted an invoice" } },
    });
    const es = readFileSync(join(root, "packages/i18n/messages/es.json"), "utf8");
    expect(es).toContain("Eliminó «time entry»");

    expect(act(format, { name: "time-entries" })).toBe("formatted 10 files");
    expect(ran[0]).toStartWith(
      "bunx biome check --write packages/contracts/src/api/time-entries.ts",
    );
  });

  it("refuses a catalog without the audit log's events", () => {
    const { root, actions, act } = generators();
    mkdirSync(join(root, "packages/i18n/messages"), { recursive: true });
    writeFileSync(join(root, "packages/i18n/messages/en.json"), "{}");
    expect(() => act(actions("api-feature")[0], { item: "invoice" })).toThrow(
      "has no workspace.audit.events",
    );
  });
});

describe("the package generator", () => {
  it("asks for a new kebab-case package and what it's for", () => {
    const root = mkdtempSync(join(tmpdir(), "generators-"));
    mkdirSync(join(root, "packages/money"), { recursive: true });
    const { prompt } = generators(root);
    const name = prompt("package", "name");
    expect(name.validate("Money")).toContain("kebab-case");
    expect(name.validate("money")).toBe("packages/money exists");
    expect(name.validate("dates")).toBe(true);
    const description = prompt("package", "description");
    expect(description.validate(" ")).toContain("Say what");
    expect(description.validate('Has "quotes"')).toContain("Say what");
    expect(description.validate("Formatting for amounts of money.")).toBe(true);
  });

  it("formats the package, then installs it", () => {
    const { ran, actions, act } = generators();
    const [format, install] = actions("package");
    expect(act(format, { name: "money" })).toBe("formatted 1 files");
    expect(act(install, {})).toBe("bun install");
    expect(ran).toEqual(["bunx biome check --write packages/money", "bun install"]);
  });

  it("runs its commands in the destination", () => {
    const root = mkdtempSync(join(tmpdir(), "generators-"));
    // A dependency on a folder of its own: bun install links it, offline, and locks it.
    mkdirSync(join(root, "local"));
    writeFileSync(join(root, "local/package.json"), '{ "name": "local", "version": "1.0.0" }');
    writeFileSync(
      join(root, "package.json"),
      '{ "name": "scratch", "private": true, "dependencies": { "local": "file:./local" } }',
    );
    const set: Record<string, PlopTypes.PlopGeneratorConfig> = {};
    generator({
      getDestBasePath: () => root,
      setGenerator: (name: string, config: PlopTypes.PlopGeneratorConfig) => {
        set[name] = config;
      },
      getHelper: (name: string) => HELPERS[name],
    } as unknown as PlopTypes.NodePlopAPI);
    const install = ((set.package?.actions ?? []) as unknown[]).at(
      -1,
    ) as PlopTypes.CustomActionFunction;
    expect(install({}, {} as never, {} as never)).toBe("bun install");
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toContain('"name": "scratch"');
  });
});

describe("what plop loads", () => {
  // plop calls it with a second argument of its own: a runner parameter there broke
  // `bun run gen:new` ("run is not a function").
  it("takes plop alone, and sets up every generator with plop's own arguments", () => {
    expect(generator.length).toBe(1);
    const names: string[] = [];
    const plop = {
      getDestBasePath: () => tmpdir(),
      setGenerator: (name: string) => names.push(name),
      getHelper: (name: string) => HELPERS[name],
    } as unknown as PlopTypes.NodePlopAPI;
    (generator as (...args: unknown[]) => void)(plop, { force: false });
    expect(names.sort()).toEqual(["api-feature", "package"]);
  });
});
