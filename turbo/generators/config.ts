/**
 * Code generators: `bun run gen:new` picks one interactively, or name it and pass the
 * answers in order:
 *
 *   bun run gen:new api-feature --args projects project project '{"name":"Launch"}'
 *   bun run gen:new package --args money "Formatting and arithmetic for amounts of money."
 *
 * Each writes files that already pass lint, types, knip and their tests, wires them in,
 * and formats everything it touched; CI runs both into a scratch copy to keep it so
 * (scripts/generators.ts). The .claude/skills add-feature and add-package say what to do next.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlopTypes } from "@turbo/gen";
import * as z from "zod";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

type Format = (paths: (answers: PlopTypes.Answers) => string[]) => PlopTypes.CustomActionFunction;

/** The answers code reads (plop leaves them untyped). */
const named = z.object({ name: z.string() });
const itemized = z.object({ item: z.string() });

/** One of plop's case helpers, the ones the templates use, as a typed function. */
const helper = (plop: PlopTypes.NodePlopAPI, name: string) => (value: string) =>
  z.string().parse(plop.getHelper(name)(value));

/** The part of a translation catalog the audit log's event labels live in. */
const catalog = z.object({
  workspace: z.object({ audit: z.object({ events: z.record(z.string(), z.unknown()) }) }),
});
// A guard rather than a parse: the catalog is written back with its keys in their order.
const isCatalog = (value: unknown): value is z.infer<typeof catalog> =>
  catalog.safeParse(value).success;

/** The contract, its export and its deletion event. */
const CONTRACT_ACTIONS: PlopTypes.ActionType[] = [
  {
    type: "add",
    path: "packages/contracts/src/api/{{kebabCase name}}.ts",
    templateFile: "templates/api-feature/contract.ts.hbs",
  },
  {
    type: "modify",
    path: "packages/contracts/src/api/index.ts",
    pattern: /(import \{ populateContractRouterPaths \} from "@orpc\/contract";\n)/,
    template: '$1import { {{camelCase name}}Contract } from "./{{kebabCase name}}";\n',
  },
  {
    type: "modify",
    path: "packages/contracts/src/api/index.ts",
    pattern: /(\n\}\);\n\nexport type Contract = typeof contract;\n\n)/,
    template:
      '\n  {{camelCase name}}: {{camelCase name}}Contract,$1export * from "./{{kebabCase name}}";\n',
  },
  {
    type: "modify",
    path: "packages/contracts/src/events.ts",
    pattern: /(\nexport const events = \{\n)/,
    template:
      '$1  "{{snakeCase item}}.deleted.v1": z.object({ {{camelCase item}}Id: z.uuid() }),\n',
  },
];

/** The apps/api module, wired into the app and the router, its client hook and its test. */
const MODULE_ACTIONS: PlopTypes.ActionType[] = [
  {
    type: "add",
    path: "apps/api/src/modules/{{kebabCase name}}/index.ts",
    templateFile: "templates/api-feature/index.ts.hbs",
  },
  {
    type: "add",
    path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.module.ts",
    templateFile: "templates/api-feature/module.ts.hbs",
  },
  {
    type: "add",
    path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.repository.ts",
    templateFile: "templates/api-feature/repository.ts.hbs",
  },
  {
    type: "add",
    path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.service.ts",
    templateFile: "templates/api-feature/service.ts.hbs",
  },
  {
    type: "add",
    path: "apps/api/src/modules/{{kebabCase name}}/{{kebabCase name}}.router.ts",
    templateFile: "templates/api-feature/router.ts.hbs",
  },
  {
    type: "modify",
    path: "apps/api/src/app.module.ts",
    pattern: /(import \{ env \} from "\.\/env";\n)/,
    template: '$1import { {{pascalCase name}}Module } from "./modules/{{kebabCase name}}";\n',
  },
  {
    type: "modify",
    path: "apps/api/src/app.module.ts",
    pattern: /(\n {2}\],\n\}\)\nexport class AppModule)/,
    template: "\n    {{pascalCase name}}Module,$1",
  },
  {
    type: "modify",
    path: "apps/api/src/rpc/router.ts",
    pattern: /(import type \{ Procedures \} from "\.\/procedures";\n)/,
    template:
      'import { {{pascalCase name}}Service, {{camelCase name}}Router } from "../modules/{{kebabCase name}}";\n$1',
  },
  {
    type: "modify",
    path: "apps/api/src/rpc/router.ts",
    pattern: /(\n {2}\}\);\n\}\n\nexport type AppRouter)/,
    template:
      "\n    {{camelCase name}}: {{camelCase name}}Router(procedures, app.get({{pascalCase name}}Service)),$1",
  },
  {
    type: "add",
    path: "packages/client/src/api/{{kebabCase name}}/list.ts",
    templateFile: "templates/api-feature/client-list.ts.hbs",
  },
  {
    type: "append",
    path: "apps/api/test/api.integration.test.ts",
    templateFile: "templates/api-feature/integration-test.ts.hbs",
    // plop's uniqueness check turns the rendered test into an unescaped regular
    // expression, which `??` breaks; the module name is new (validated), so skip it.
    unique: false,
  },
];

/** The api-feature generator's questions. */
function apiFeaturePrompts(plop: PlopTypes.NodePlopAPI, root: string): PlopTypes.PromptQuestion[] {
  return [
    {
      type: "input",
      name: "name",
      message: "Feature name, kebab-case plural (the route and module), e.g. projects:",
      validate: (value: string) => {
        if (!KEBAB.test(value)) {
          return "Use kebab-case, e.g. projects or time-entries";
        }
        if (existsSync(join(root, "apps/api/src/modules", value))) {
          return `${value} exists`;
        }
        return true;
      },
    },
    {
      type: "input",
      name: "item",
      message: "One item, singular (names the schema and type), e.g. project:",
      default: (answers: PlopTypes.Answers) => named.parse(answers).name.replace(/s$/, ""),
      validate: (value: string) => KEBAB.test(value) || "Use kebab-case, e.g. time-entry",
    },
    {
      type: "input",
      name: "model",
      message:
        "Prisma client accessor of its table (already in packages/db/prisma/schema, with org_id and RLS), e.g. project:",
      default: (answers: PlopTypes.Answers) =>
        helper(plop, "camelCase")(itemized.parse(answers).item),
      validate: (value: string) => CAMEL.test(value) || "The camelCase accessor, e.g. timeEntry",
    },
    {
      type: "input",
      name: "row",
      message:
        'The columns a test row needs besides org_id, as JSON (the generated test inserts rows), e.g. {"name": "Launch"}:',
      default: "{}",
      validate: (value: string) => {
        try {
          const row: unknown = JSON.parse(value);
          return (
            (typeof row === "object" && row !== null && !Array.isArray(row)) || "A JSON object"
          );
        } catch {
          return 'A JSON object, e.g. {"name": "Launch"}';
        }
      },
    },
  ];
}

/** The audit log describes every event in every language: English, and a Spanish draft. */
function describeEvent(plop: PlopTypes.NodePlopAPI, root: string): PlopTypes.CustomActionFunction {
  return (answers) => {
    const { item } = itemized.parse(answers);
    const words = helper(plop, "lowerCase")(helper(plop, "sentenceCase")(item));
    const article = /^[aeiou]/.test(words) ? "an" : "a";
    const labels = { en: `Deleted ${article} ${words}`, es: `Eliminó «${words}»` };
    for (const [locale, label] of Object.entries(labels)) {
      const path = join(root, `packages/i18n/messages/${locale}.json`);
      const messages: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isCatalog(messages)) {
        throw new Error(`${path} has no workspace.audit.events`);
      }
      messages.workspace.audit.events[helper(plop, "snakeCase")(item)] = {
        deleted: { v1: label },
      };
      writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
    }
    return "described its event in the audit log";
  };
}

function apiFeature(plop: PlopTypes.NodePlopAPI, root: string, format: Format) {
  plop.setGenerator("api-feature", {
    description:
      "An API feature over an existing tenant table (list, and delete with its event): contract, apps/api module, client hook, integration test",
    prompts: apiFeaturePrompts(plop, root),
    actions: [
      ...CONTRACT_ACTIONS,
      describeEvent(plop, root),
      ...MODULE_ACTIONS,
      format((answers) => {
        const kebab = helper(plop, "kebabCase")(named.parse(answers).name);
        return [
          `packages/contracts/src/api/${kebab}.ts`,
          "packages/contracts/src/api/index.ts",
          "packages/contracts/src/events.ts",
          "packages/i18n/messages/en.json",
          "packages/i18n/messages/es.json",
          `apps/api/src/modules/${kebab}`,
          "apps/api/src/app.module.ts",
          "apps/api/src/rpc/router.ts",
          `packages/client/src/api/${kebab}`,
          "apps/api/test/api.integration.test.ts",
        ];
      }),
    ],
  });
}

function packageGenerator(
  plop: PlopTypes.NodePlopAPI,
  root: string,
  format: Format,
  run: (command: string, args: string[]) => void,
) {
  plop.setGenerator("package", {
    description: "A shared TypeScript package under packages/, consumed as source",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name, kebab-case (becomes @repo/<name> and a commit scope):",
        validate: (value: string) => {
          if (!KEBAB.test(value)) {
            return "Use kebab-case, e.g. money";
          }
          if (existsSync(join(root, "packages", value))) {
            return `packages/${value} exists`;
          }
          return true;
        },
      },
      {
        type: "input",
        name: "description",
        message: "One sentence: what it is for:",
        // It lands in package.json as is, so no quotes or backslashes.
        validate: (value: string) =>
          (value.trim().length > 0 && !/["\\]/.test(value)) ||
          "Say what the package is for, without quotes or backslashes",
      },
    ],
    actions: [
      {
        type: "add",
        path: "packages/{{kebabCase name}}/package.json",
        templateFile: "templates/package/package.json.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/tsconfig.json",
        templateFile: "templates/package/tsconfig.json.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/vitest.config.ts",
        templateFile: "templates/package/vitest.config.ts.hbs",
      },
      {
        type: "add",
        path: "packages/{{kebabCase name}}/src/index.ts",
        templateFile: "templates/package/index.ts.hbs",
      },
      format((answers) => [`packages/${helper(plop, "kebabCase")(named.parse(answers).name)}`]),
      // Links the new workspace so other packages can depend on it.
      () => {
        run("bun", ["install"]);
        return "bun install";
      },
    ],
  });
}

/** Runs a command in `root` to the end, its output on the terminal; throws when it fails. */
const runIn = (root: string) => (command: string, args: string[]) => {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
};

/** Sets up every generator on `plop`, running commands through `run`. */
export function setUp(
  plop: PlopTypes.NodePlopAPI,
  run: (command: string, args: string[]) => void,
): void {
  const root = plop.getDestBasePath();

  // Rewrites the touched files the way `bun run format` would (import order included),
  // so an insertion never has to know where it sorts.
  const format: Format = (paths) => (answers) => {
    const files = paths(answers);
    run("bunx", ["biome", "check", "--write", ...files]);
    return `formatted ${files.length} files`;
  };

  apiFeature(plop, root, format);
  packageGenerator(plop, root, format, run);
}

/**
 * What plop loads. It takes `plop` alone: plop calls it with a second argument of its own,
 * which would otherwise land where `setUp` takes its command runner.
 */
export default function generator(plop: PlopTypes.NodePlopAPI): void {
  setUp(plop, runIn(plop.getDestBasePath()));
}
