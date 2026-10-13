/**
 * One-time (and re-runnable) project setup: creates .env with fresh secrets, installs
 * dependencies, starts local services, applies migrations and generates code.
 *
 *   bun run setup
 *   bun scripts/setup.ts --env   only .env (what `bun dev` runs first, after a pull)
 *   bun run setup --stack <n>    this checkout gets its own services and app ports (a
 *                                worktree next to another that runs them): compose
 *                                project `<name>-stack<n>`, every port 100 × n up (1 to
 *                                9; 0 goes back to the defaults). packages/testing/src/stack.ts
 *
 * Safe to run again: existing .env values are kept; only missing variables are added
 * and placeholders are replaced.
 */

import { constants, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// By path, not package name: setup writes .env before `bun install` has linked packages.
import { fillPlaceholders } from "../packages/testing/src/secrets";
import { STACK_FILE, STACKS, stackValues } from "../packages/testing/src/stack";
import {
  ENV_EXAMPLE_PATH,
  ENV_PATH,
  envLine,
  errno,
  fail,
  ok,
  ROOT,
  readEnv,
  runMain,
  runSync,
  writeEnvValue,
} from "./lib";

/** The steps after .env, each a command that must pass before the next. */
const STEPS: [string, string[]][] = [
  ["2. Dependencies", ["bun", "install"]],
  ["3. Local services", ["bun", "scripts/services.ts", "up"]],
  ["4. Database", ["bun", "run", "db:deploy"]],
  ["5. Code generation", ["bun", "run", "gen"]],
];

/**
 * Brings .env up to .env.example: creates it, adds what's missing, and turns
 * placeholders into fresh secrets. Existing values stay.
 */
export function syncEnv(envPath = ENV_PATH, examplePath = ENV_EXAMPLE_PATH) {
  // Copied only if there's none, in one step: a check first, then the copy, could
  // overwrite a .env made in between.
  try {
    copyFileSync(examplePath, envPath, constants.COPYFILE_EXCL);
    ok("Created .env from .env.example");
  } catch (error) {
    if (!errno(error, "EEXIST")) {
      throw error;
    }
  }
  const env = readEnv(envPath);
  for (const [key, value] of readEnv(examplePath)) {
    if (!env.has(key)) {
      writeEnvValue(envPath, key, value);
    }
  }
  // Placeholders become fresh secrets in each variable's format (the VAPID pair together).
  const current = Object.fromEntries(readEnv(envPath));
  for (const [key, value] of Object.entries(fillPlaceholders(current))) {
    if (value !== current[key]) {
      writeEnvValue(envPath, key, value);
      ok(`Generated ${key}`);
    }
  }
}

/** The compose project's name (docker-compose.yml's `name:`). */
export const composeProject = (root = ROOT) =>
  /^name:\s*(\S+)/m.exec(readFileSync(join(root, "docker-compose.yml"), "utf8"))?.[1] ?? "app";

/**
 * Moves this checkout's services to `stack`: the ports, local URLs and compose project in
 * `envPath`, and `.env.stack` beside it, the same moves over .env.example, for the tests.
 */
export function useStack(stack: number, envPath: string, examplePath: string, project: string) {
  const example = Object.fromEntries(readEnv(examplePath));
  const changes = stackValues(Object.fromEntries(readEnv(envPath)), example, stack, project);
  for (const [key, value] of Object.entries(changes)) {
    writeEnvValue(envPath, key, value);
  }
  const forTests = join(dirname(envPath), STACK_FILE);
  if (stack === 0) {
    rmSync(forTests, { force: true });
  } else {
    const values = Object.entries(stackValues(example, example, stack));
    writeFileSync(forTests, `${values.map(([key, value]) => envLine(key, value)).join("\n")}\n`);
  }
  const env = readEnv(envPath);
  ok(
    `Stack ${stack}: compose project ${env.get("COMPOSE_PROJECT_NAME")}, Postgres on ${env.get("POSTGRES_PORT")}, Valkey on ${env.get("VALKEY_PORT")}, the site on ${env.get("WEB_URL")}`,
  );
}

interface Options {
  run?: typeof runSync;
  envPath?: string;
  examplePath?: string;
  /** The stack to move to (`--stack <n>`), if any. */
  stack?: number;
  project?: string;
}

/** Writes `envPath` from `examplePath`, then runs the steps; the exit code. */
export function setup({
  run = runSync,
  envPath = ENV_PATH,
  examplePath = ENV_EXAMPLE_PATH,
  stack,
  project = composeProject(),
}: Options = {}) {
  console.log("\n1. Environment");
  syncEnv(envPath, examplePath);
  if (stack !== undefined) {
    useStack(stack, envPath, examplePath, project);
  }
  for (const [title, [command = "", ...args]] of STEPS) {
    console.log(`\n${title}`);
    const { status } = run(command, args, { stdio: "inherit" });
    if (status !== 0) {
      return status ?? 1;
    }
  }
  console.log("\nSetup complete. Start everything with `bun dev`.\n");
  return 0;
}

/** The command: .env only with `--env`, otherwise the whole setup; the exit code. */
export function main(argv = process.argv.slice(2), options: Omit<Options, "stack"> = {}) {
  const at = argv.indexOf("--stack");
  const stack = at === -1 ? undefined : Number(argv[at + 1]);
  if (stack !== undefined && !(Number.isInteger(stack) && stack >= 0 && stack < STACKS)) {
    fail(`--stack takes a number from 0 to ${STACKS - 1}.`);
    return 1;
  }
  if (!argv.includes("--env")) {
    return setup({ ...options, stack });
  }
  const { envPath = ENV_PATH, examplePath = ENV_EXAMPLE_PATH } = options;
  syncEnv(envPath, examplePath);
  if (stack !== undefined) {
    useStack(stack, envPath, examplePath, options.project ?? composeProject());
  }
  return 0;
}

await runMain(import.meta, main);
