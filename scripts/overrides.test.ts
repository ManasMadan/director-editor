import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  overrides?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
};
const skill = readFileSync(join(root, ".claude/skills/dependency-update/SKILL.md"), "utf8");

/** The skill's "Overrides and patches" table: each package and its review-by date. */
const rows = new Map(
  [...skill.matchAll(/^\| `([^`]+)` \|.*\| (\d{4}-\d{2}-\d{2}) \|$/gm)].map(
    ([, name, reviewBy]) => [name, reviewBy],
  ),
);

describe("overrides and patches", () => {
  // A forced version or a patch nobody can explain is never dropped: each one says why
  // it's there, when it can go, and by when to look again.
  it.each([
    ...Object.keys(manifest.overrides ?? {}),
    // "name@version", where the name may be scoped.
    ...Object.keys(manifest.patchedDependencies ?? {}).map((key) => key.replace(/(.)@.*$/, "$1")),
  ])("documents %s in the dependency-update skill, with a review date to come", (name) => {
    const reviewBy = rows.get(name);
    expect(reviewBy, `${name} has no row with a review-by date`).toBeDefined();
    expect(
      new Date(`${reviewBy}T00:00:00Z`).getTime(),
      `${name} was due for review on ${reviewBy}: drop it, or say why not and move the date`,
    ).toBeGreaterThan(Date.now());
  });
});
