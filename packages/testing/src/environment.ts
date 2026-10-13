/**
 * The environment every test runs with, the same locally and in CI: `.env.example`'s
 * values (the ports docker compose publishes, local defaults), with its placeholder
 * secrets replaced by fresh ones. Variables already set win, which is how CI points the
 * tests at its own services. A developer's `.env` is never read, so a test can't pass only
 * because of what one machine has configured. A checkout with its own stack of services
 * (`.env.stack`, see stack.ts) gets that stack's ports, so its tests use its services.
 *
 * Each package with integration tests calls `applyTestEnvironment()` at the top of its
 * vitest.config.ts, before global setup and the test workers start (they inherit it).
 * The Python service does the same in apps/ai/tests/conftest.py.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
// Through the package name, which Node resolves to the .ts file (vitest.config.ts loads this
// under Node's own loader, where a relative import needs an extension).
import { fillPlaceholders } from "@repo/testing/secrets";
import { STACK_FILE } from "@repo/testing/stack";

/** The repository's `.env.example`, found from `from` upwards. */
export function findEnvExample(from = process.cwd()): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, ".env.example");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      throw new Error(`No .env.example above ${from}`);
    }
  }
}

/**
 * The test environment, from the file at `example`. An empty value there means "not set"
 * (the services read it that way), so it's left out, like in CI: a test's own default
 * (`process.env.S3_BUCKET ?? "uploads"`) then applies.
 */
export function testEnvironment(example = findEnvExample()): Record<string, string> {
  const values = parseEnv(readFileSync(example, "utf8"));
  const stack = join(dirname(example), STACK_FILE);
  if (existsSync(stack)) {
    Object.assign(values, parseEnv(readFileSync(stack, "utf8")));
  }
  // The test runner sets NODE_ENV (test); the example's is for `bun dev`.
  delete values.NODE_ENV;
  return fillPlaceholders(
    Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]),
    ),
  );
}

/** Sets every test variable the environment doesn't already have; returns what it set. */
export function applyTestEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  example = findEnvExample(),
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(testEnvironment(example))) {
    if (env[key] !== undefined) {
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
