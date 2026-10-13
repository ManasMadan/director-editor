/**
 * The Claude Code setup's frontmatter: Claude Code ignores a field it doesn't know and
 * drops every field of a block that isn't valid YAML (a stray ": " in a description is
 * enough), both silently. This fails instead. The fields are the ones documented at
 * code.claude.com/docs/en/skills, /sub-agents and /memory (rules read only `paths`).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib";

const SKILL_FIELDS = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "compatibility",
]);
const AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "initialPrompt",
  "memory",
  "effort",
  "background",
  "omitClaudeMd",
  "isolation",
  "color",
  "experimental",
]);

const CLAUDE = join(ROOT, ".claude");

/**
 * The plugins from Anthropic's marketplace that settings.json enables and the template's
 * plugin depends on: code intelligence for TypeScript and the AI service, Expo, Stripe,
 * Redis (Valkey), Terraform (OpenTofu) and the security review. Playwright is driven
 * through its CLI (Playwright's official skills), not the playwright plugin's MCP server.
 */
const OFFICIAL_PLUGINS = [
  "typescript-lsp",
  "pyright-lsp",
  "expo",
  "stripe",
  "redis-development",
  "terraform",
  "security-guidance",
].map((name) => `${name}@claude-plugins-official`);

function frontmatter(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) {
    throw new Error(`${path} has no frontmatter`);
  }
  const end = text.indexOf("\n---", 3);
  return Bun.YAML.parse(text.slice(4, end)) as Record<string, unknown>;
}

const skills = readdirSync(join(CLAUDE, "skills"));
const agents = readdirSync(join(CLAUDE, "agents")).map((file) => file.replace(/\.md$/, ""));

describe("skills", () => {
  it.each(skills)("%s has valid, documented frontmatter", (skill) => {
    const fields = frontmatter(join(CLAUDE, "skills", skill, "SKILL.md"));
    expect(Object.keys(fields).filter((field) => !SKILL_FIELDS.has(field))).toEqual([]);
    expect(fields.name).toBe(skill);
    expect(typeof fields.description).toBe("string");
    if (typeof fields.agent === "string") {
      expect(agents).toContain(fields.agent);
    }
  });

  it("start the seam swaps only when a person asks", () => {
    for (const skill of skills.filter((name) => name.startsWith("swap-"))) {
      expect(frontmatter(join(CLAUDE, "skills", skill, "SKILL.md"))).toMatchObject({
        "disable-model-invocation": true,
      });
    }
  });
});

describe("agents", () => {
  it.each(agents)("%s has valid, documented frontmatter", (agent) => {
    const fields = frontmatter(join(CLAUDE, "agents", `${agent}.md`));
    expect(Object.keys(fields).filter((field) => !AGENT_FIELDS.has(field))).toEqual([]);
    expect(fields.name).toBe(agent);
    expect(typeof fields.description).toBe("string");
    expect(typeof fields.model).toBe("string");
    expect(typeof fields.permissionMode).toBe("string");
    for (const skill of (fields.skills as string[] | undefined) ?? []) {
      expect(skills).toContain(skill);
    }
  });
});

describe("rules", () => {
  it.each(readdirSync(join(CLAUDE, "rules")))("%s scopes itself with paths only", (rule) => {
    const fields = frontmatter(join(CLAUDE, "rules", rule));
    expect(Object.keys(fields)).toEqual(["paths"]);
    expect(Array.isArray(fields.paths)).toBe(true);
  });
});

describe("settings.json", () => {
  type Hooks = Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  const settings = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8")) as {
    hooks: Hooks;
    statusLine: { command: string };
  };
  const commands = (events: Hooks) =>
    Object.values(events).flatMap((matchers) =>
      matchers.flatMap((matcher) => matcher.hooks.map((hook) => hook.command)),
    );
  const scripts = (command: string) =>
    [...command.matchAll(/\.claude\/hooks\/([\w-]+\.ts)/g)].map((match) => match[1]);

  it("wires every hook entry point, and only files that exist", () => {
    const wired = [...commands(settings.hooks), settings.statusLine.command].flatMap(scripts);
    const entryPoints = readdirSync(join(CLAUDE, "hooks")).filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        readFileSync(join(CLAUDE, "hooks", file), "utf8").includes("runMain(import.meta"),
    );
    expect([...new Set(wired)].sort()).toEqual(entryPoints.sort());
  });

  it("enables the plugins this repository is set up for", () => {
    const { enabledPlugins } = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8")) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(enabledPlugins).toMatchObject(
      Object.fromEntries(
        ["worktrunk@worktrunk", ...OFFICIAL_PLUGINS].map((plugin) => [plugin, true]),
      ),
    );
  });

  it("lets Claude run every lint script and CodeQL without asking", () => {
    const { permissions } = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8")) as {
      permissions: { allow: string[] };
    };
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const checks = Object.keys(scripts).filter(
      (name) => name === "codeql" || name === "lint" || name.startsWith("lint:"),
    );
    const missing = checks
      .flatMap((name) => [`Bash(bun run ${name})`, `Bash(bun run ${name} *)`])
      .filter((rule) => !permissions.allow.includes(rule));
    expect(missing).toEqual([]);
  });

  it("drives a browser with Playwright's CLI, not its MCP server", () => {
    const { mcpServers } = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(mcpServers)).toEqual(["postgres"]);
  });

  it("lets Playwright's official skills run their commands", () => {
    const { permissions } = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8")) as {
      permissions: { allow: string[] };
    };
    expect(permissions.allow).toEqual(
      expect.arrayContaining(["Bash(playwright-cli *)", "Bash(npx playwright trace *)"]),
    );
  });

  it("points a pyright language server at the AI service's code and environment", () => {
    const { tool } = Bun.TOML.parse(readFileSync(join(ROOT, "pyproject.toml"), "utf8")) as {
      tool: { pyright: { executionEnvironments: { root: string }[]; venvPath: string } };
    };
    expect(tool.pyright.executionEnvironments).toEqual([{ root: "apps/ai" }]);
    expect(tool.pyright.venvPath).toBe("apps/ai");
  });

  it("blocks a tool call when Bun is missing, instead of skipping the guard", () => {
    for (const command of commands({ PreToolUse: settings.hooks.PreToolUse ?? [] })) {
      expect(command).toStartWith("command -v bun >/dev/null 2>&1 || {");
      expect(command).toContain("exit 2; }; bun ");
    }
  });
});

// Apps made from this template can take the setup from here as a plugin, so it has to
// carry the same skills, agents and hooks as the project's own .claude.
describe("the plugin", () => {
  const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  const plugin = read(".claude-plugin/plugin.json") as {
    name: string;
    skills: string[];
    agents: string[];
    outputStyles: string;
    dependencies: string[];
    hooks: unknown;
  };

  it("lists every agent, and takes the skills and output styles by folder", () => {
    expect(plugin.agents).toEqual(agents.sort().map((agent) => `./.claude/agents/${agent}.md`));
    expect(plugin.skills).toEqual(["./.claude/skills/"]);
    expect(plugin.outputStyles).toBe("./.claude/output-styles/");
  });

  it("runs the same hooks as the project, from the plugin's copy", () => {
    const settings = readFileSync(join(CLAUDE, "settings.json"), "utf8");
    const hooks = (JSON.parse(settings) as { hooks: unknown }).hooks;
    const fromPlugin = JSON.stringify(hooks).replaceAll(
      "$CLAUDE_PROJECT_DIR/.claude/hooks/",
      `$\{CLAUDE_PLUGIN_ROOT}/.claude/hooks/`,
    );
    expect(plugin.hooks).toEqual(JSON.parse(fromPlugin));
  });

  it("is the marketplace's one plugin, at the repository's root", () => {
    const marketplace = read(".claude-plugin/marketplace.json") as {
      plugins: { name: string; source: string }[];
      allowCrossMarketplaceDependenciesOn: string[];
    };
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: plugin.name, source: "./" }),
    ]);
    expect(marketplace.allowCrossMarketplaceDependenciesOn).toEqual(["claude-plugins-official"]);
  });

  it("installs the official plugins the project enables", () => {
    expect(plugin.dependencies).toEqual(OFFICIAL_PLUGINS);
  });
});
