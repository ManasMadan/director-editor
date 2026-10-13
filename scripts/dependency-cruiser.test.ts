import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT } from "./lib";

const config = createRequire(import.meta.url)(join(ROOT, ".dependency-cruiser.cjs")) as {
  options: { exclude: { path: string[] } };
};

describe("the dependency rules (bun run lint:boundaries)", () => {
  it("never read what the tools write next to the code", () => {
    // A test run writes coverage reports while lint runs beside it (the pre-push hook), and
    // depcruise fails on a file deleted between its listing and its read.
    const outputs = [
      "coverage",
      "playwright-report",
      "test-results",
      "storybook-static",
      "dist",
      ".next",
      ".venv",
    ];
    const read = outputs.filter(
      (dir) =>
        !config.options.exclude.path.some((path) =>
          new RegExp(path).test(`packages/email/${dir}/x.js`),
        ),
    );
    expect(read).toEqual([]);
  });
});
