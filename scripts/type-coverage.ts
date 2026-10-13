/**
 * No `any` and no casts in the source: type-coverage in its strict mode, for every
 * TypeScript workspace and the repo's own scripts, load test and code generators, at 100%. An `any` turns off checking for everything that flows
 * from it (a JSON body, a job's data, a library's generic left at its default), and a
 * type assertion or a non-null `!` is a claim the compiler can't check, so each becomes
 * a parse, a type guard, a check that throws (`required` in @repo/contracts/objects) or
 * a better-typed call. `as const` is fine. The few lines with no typed alternative carry
 * the tool's ignore comment and are listed in docs/testing.md (Type-coverage
 * exceptions), which the suppressions check enforces. Tests, stories, test setup and
 * generated code are left out.
 *
 *   bun run type-coverage              every workspace
 *   bun run type-coverage apps/api     one, with each `any` it finds
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, ROOT, type Run, runMain, runSync } from "./lib";

const IGNORED = [
  "**/generated/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/test/**",
  "**/e2e/**",
  "**/*.stories.tsx",
  "**/.storybook/**",
  "**/jest.setup.ts",
];

/**
 * Every workspace with its own tsconfig (the Python service and config packages have
 * none), and the other TypeScript the repo runs: its scripts, the load test and the code
 * generators.
 */
export function workspaces(root = ROOT): string[] {
  return [
    ...["apps", "packages"].flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => `${dir}/${name}`),
    ),
    "scripts",
    "load",
    "turbo/generators",
  ].filter((path) => existsSync(join(root, path, "tsconfig.json")));
}

/** Checks each workspace; the ones below 100%. */
export function check(paths: string[], run: Run = runSync): string[] {
  return paths.filter((path) => {
    const args = [
      "type-coverage",
      "-p",
      `${path}/tsconfig.json`,
      "--strict",
      "--at-least",
      "100",
      "--detail",
    ];
    for (const pattern of IGNORED) {
      args.push("--ignore-files", pattern);
    }
    const result = run("bunx", args, { cwd: ROOT });
    if (result.status === 0) {
      ok(path);
      return false;
    }
    fail(path);
    console.error(`${result.stdout}${result.stderr}`.trim());
    return true;
  });
}

/** The command: the given workspaces, or all of them; the exit code. */
export function main(argv = process.argv.slice(2), run: Run = runSync): number {
  return check(argv.length ? argv : workspaces(), run).length ? 1 : 0;
}

await runMain(import.meta, main);
