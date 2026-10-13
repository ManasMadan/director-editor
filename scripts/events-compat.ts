/**
 * Domain events against the base branch's: a published `*.vN` event may only gain
 * optional fields. Its consumers (the audit log, notifications, customers' webhook
 * receivers) run old and new code side by side during a deploy and read events long
 * after they were written, so removing, renaming, retyping or requiring a field breaks
 * them. Anything else is a new version (packages/contracts/src/events.ts).
 *
 *   bun scripts/events-compat.ts <base ref>
 *
 * It compares packages/jobs/generated/events.json, which `bun run gen` writes from the
 * zod schemas and the codegen job keeps current.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import { runMain } from "./lib";

const CATALOG = "packages/jobs/generated/events.json";

/** generated/events.json: each event's JSON Schema, by name. */
const catalog = z.record(
  z.string(),
  z.looseObject({ properties: z.record(z.string(), z.unknown()).optional() }),
);
type Catalog = z.infer<typeof catalog>;

/** How each event in `base` changed in `head` in a way its consumers can't take. */
export function breakingChanges(base: Catalog, head: Catalog): string[] {
  return Object.entries(base).flatMap(([name, before]) => {
    const after = head[name];
    if (!after) {
      return [`${name} was removed`];
    }
    // Fields the base didn't have are fine, if optional: the required list shows that.
    const properties = Object.fromEntries(
      Object.entries(after.properties ?? {}).filter(
        ([field]) => field in (before.properties ?? {}),
      ),
    );
    const comparable = after.properties ? { ...after, properties } : after;
    return isDeepStrictEqual(comparable, before)
      ? []
      : [`${name} changed other than by adding optional fields: publish a new version instead`];
  });
}

/** The check against `baseRef`, with git and the working tree passed in. */
export function check(
  baseRef: string,
  show = (ref: string, path: string) =>
    Bun.spawnSync(["git", "show", `${ref}:${path}`]).stdout.toString(),
  head = () => readFileSync(join(import.meta.dir, "..", CATALOG), "utf8"),
): { problems: string[]; note?: string } {
  const base = show(baseRef, CATALOG);
  if (!base) {
    return { problems: [], note: "The base branch has no event catalog yet." };
  }
  return {
    problems: breakingChanges(catalog.parse(JSON.parse(base)), catalog.parse(JSON.parse(head()))),
  };
}

/** Prints the result, as GitHub annotations, and returns the exit code. */
export function report(
  { problems, note }: ReturnType<typeof check>,
  out: Pick<Console, "log" | "error"> = console,
) {
  if (note) {
    out.log(note);
  }
  for (const problem of problems) {
    out.error(`::error file=${CATALOG}::${problem}`);
  }
  return problems.length > 0 ? 1 : 0;
}

/** The command: the base ref from the arguments (origin/master by default); the exit code. */
export function main(argv = process.argv.slice(2)) {
  return report(check(argv[0] ?? "origin/master"));
}

await runMain(import.meta, main);
