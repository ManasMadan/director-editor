/**
 * Checks that this machine can run the repo, and says exactly how to fix what can't.
 * Runs before `bun dev`; safe to run any time (`bun run doctor`). Never prints secrets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import {
  ENV_EXAMPLE_PATH,
  ENV_PATH,
  fail,
  ok,
  PLACEHOLDER,
  ROOT,
  readEnv,
  runMain,
  runSync,
  warn,
} from "./lib";

/** What each section needs: a command's output, and a way to count a problem. */
type Doctor = {
  /** What the command prints, or null when it fails or doesn't exist. */
  version: (command: string[]) => string | null;
  problem: (message: string) => void;
};

/** Node at the major version .nvmrc names, and Bun within package.json's range. */
function checkRuntimes({ version, problem }: Doctor, bunVersion: string) {
  // .nvmrc pins the exact version CI uses; any release of that major will do locally.
  const pinnedNode = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
  const wantedNode = pinnedNode.split(".")[0];
  const node = version(["node", "--version"]);
  if (!node) {
    problem("Node is not installed. Install it with nvm: `nvm install` (reads .nvmrc).");
  } else if (node.match(/^v(\d+)\./)?.[1] !== wantedNode) {
    problem(`Node ${node} found, ${wantedNode} expected (CI uses ${pinnedNode}). Run \`nvm use\`.`);
  } else {
    ok(`Node ${node}`);
  }

  // package.json pins the Bun that CI, the images and bun.lock use (packageManager), and
  // the oldest one the scripts work with (engines).
  const manifest = z
    .object({ packageManager: z.string(), engines: z.object({ bun: z.string() }) })
    .parse(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")));
  const pinnedBun = manifest.packageManager.replace(/^bun@/, "");
  if (!Bun.semver.satisfies(bunVersion, manifest.engines.bun)) {
    problem(
      `Bun ${bunVersion} found, ${manifest.engines.bun} needed. Run \`bun upgrade\` (CI uses ${pinnedBun}).`,
    );
  } else if (bunVersion !== pinnedBun) {
    warn(
      `Bun ${bunVersion}; CI and the images use ${pinnedBun} (\`bun upgrade --version ${pinnedBun}\`).`,
    );
  } else {
    ok(`Bun ${bunVersion}`);
  }
}

/** uv, Worktrunk (optional) and Docker; whether Docker is running. */
function checkTools({ version, problem }: Doctor): boolean {
  // Not only for the Python service: codegen runs it (turbo's gen → @repo/ai-client →
  // @repo/ai#gen), and setup, dev, check-types and test all depend on codegen.
  const uv = version(["uv", "--version"]);
  if (uv) {
    ok(uv);
  } else {
    problem(
      "uv is not installed. Setup, `bun dev`, types and tests need it (the AI service's code generation): `brew install uv`, or see https://docs.astral.sh/uv/.",
    );
  }

  // Optional: parallel branches and agents in worktrees (.config/wt.toml).
  const wt = version(["wt", "--version"]);
  if (wt) {
    ok(wt);
  } else {
    warn(
      "Worktrunk isn't installed (optional: one worktree per branch, for parallel work and agents): `brew install worktrunk && wt config shell install`.",
    );
  }

  // Optional: the language servers Claude Code's typescript-lsp and pyright-lsp plugins
  // start (.claude/settings.json); without them, Claude Code reports the plugin broken.
  const servers = ["typescript-language-server", "pyright"].filter(
    (server) => !version([server, "--version"]),
  );
  if (servers.length) {
    warn(
      `Claude Code's code intelligence needs ${servers.join(" and ")} (optional): \`bun add -g ${servers.join(" ")}\`.`,
    );
  } else {
    ok("typescript-language-server and pyright, for Claude Code");
  }

  const docker = version(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (docker) {
    ok(`Docker ${docker}`);
  } else {
    problem("Docker is not running. Start Docker Desktop (or your Docker daemon).");
  }
  return Boolean(docker);
}

/** `.env` against `.env.example`: nothing missing, nothing left at a placeholder. */
function checkEnv({ problem }: Doctor, envPath: string, examplePath: string) {
  const env = readEnv(envPath);
  const example = readEnv(examplePath);
  if (env.size === 0) {
    return problem("No .env yet. Run `bun run setup`.");
  }
  const missing = [...example.keys()].filter((key) => !env.has(key));
  // `bun run setup --stack <n>` names a checkout's own compose project; .env.example
  // leaves it to docker-compose.yml's `name:`.
  const unknown = [...env.keys()].filter(
    (key) => !example.has(key) && key !== "COMPOSE_PROJECT_NAME",
  );
  const placeholders = [...env].filter(([, value]) => PLACEHOLDER.test(value)).map(([key]) => key);
  if (missing.length) {
    problem(
      `Missing in .env: ${missing.join(", ")}. Run \`bun run setup\`: it adds them, generating the secrets.`,
    );
  }
  if (unknown.length) {
    warn(
      `In .env but not in .env.example (renamed or removed?): ${unknown.join(", ")}. Remove them with \`bun run env:unset ${unknown.join(" ")}\`.`,
    );
  }
  if (placeholders.length) {
    problem(`Still set to a placeholder: ${placeholders.join(", ")}. Run \`bun run setup\`.`);
  }
  if (!missing.length && !placeholders.length) {
    ok(`${env.size} variables, in sync with .env.example`);
  }
}

/** The core compose services are up, and the database has its service roles. */
function checkServices({ version, problem }: Doctor) {
  const out = version([
    "docker",
    "compose",
    "ps",
    "--format",
    "{{.Service}} {{.Health}} {{.State}}",
  ]);
  const running = new Map(
    (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [service = "", health = "", state = ""] = line.split(" ");
        return [service, health || state] as const;
      }),
  );
  for (const service of ["postgres", "valkey", "mailpit"]) {
    const status = running.get(service);
    if (status === "healthy" || status === "running") {
      ok(`${service} ${status}`);
    } else {
      problem(`${service} is not running. Run \`bun run db:up\`.`);
    }
  }
  if (running.get("postgres") !== "healthy") {
    return;
  }

  // A volume created before the role bootstrap existed has no service roles, and every
  // service would fail with "password authentication failed".
  const roles = version([
    "docker",
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "app",
    "-Atc",
    "select count(*) from pg_roles where rolname in ('migrator','app_api','app_worker','app_notifications','app_webhooks','app_ai')",
  ]);
  if (roles === "6") {
    ok("database roles bootstrapped");
  } else {
    problem(
      "Database roles are missing (volume predates infra/postgres/init). Recreate it: `docker compose down -v && bun run setup` (this deletes local data).",
    );
  }
}

/**
 * Checks the tools, `envPath` against `examplePath`, and the local services; the exit
 * code. `bunVersion` is the running Bun's.
 */
export function doctor({
  run = runSync,
  envPath = ENV_PATH,
  examplePath = ENV_EXAMPLE_PATH,
  bunVersion = Bun.version,
} = {}): number {
  let problems = 0;
  const checks: Doctor = {
    version: ([name = "", ...args]) => {
      const result = run(name, args);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    problem: (message) => {
      problems += 1;
      fail(message);
    },
  };

  console.log("\nTools");
  checkRuntimes(checks, bunVersion);
  const docker = checkTools(checks);
  console.log("\nEnvironment (.env)");
  checkEnv(checks, envPath, examplePath);
  if (docker) {
    console.log("\nLocal services (docker compose)");
    checkServices(checks);
  }

  console.log(problems ? `\n${problems} problem(s) found.\n` : "\nAll good.\n");
  return problems ? 1 : 0;
}

await runMain(import.meta, doctor);
