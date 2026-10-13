import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runSync } from "./lib";

/**
 * Minutes, hours and days written as bare numbers: in seconds for one API and
 * milliseconds for the next, they're where a unit slips. packages/contracts/src/time.ts
 * names each with its unit; everything else uses those.
 */
const BARE =
  /\b(60_?000|3_?600_?000|86_?400_?000|86_?400|3_?600)\b|\b60 \* (60|1000)\b|\b24 \* (60|3600)\b/;

export function bareDurations(files: Map<string, string>) {
  return [...files].flatMap(([path, text]) =>
    text.split("\n").flatMap((line, index) => (BARE.test(line) ? [`${path}:${index + 1}`] : [])),
  );
}

describe("durations", () => {
  it("finds minutes, hours and days written as bare numbers", () => {
    const files = new Map([
      ["a.ts", "const HOUR = 3_600_000;\nconst ttl = 24 * 60 * 60;"],
      ["b.ts", "setTimeout(done, 60_000);\nconst ok = 2 * HOUR_MS;\nconst port = 13600;"],
    ]);
    expect(bareDurations(files)).toEqual(["a.ts:1", "a.ts:2", "b.ts:1"]);
  });

  it("are named with their unit everywhere in the source", () => {
    const tracked = runSync("git", [
      "ls-files",
      "apps/*/src/**",
      "packages/*/src/**",
      "scripts/*.ts",
    ]).stdout.split("\n");
    const sources = tracked.filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        !/\.test\.tsx?$/.test(path) &&
        !path.includes("/generated/") &&
        path !== "packages/contracts/src/time.ts",
    );
    const files = new Map(sources.map((path) => [path, readFileSync(path, "utf8")] as const));
    expect(bareDurations(files)).toEqual([]);
  });
});
