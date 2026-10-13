/**
 * Every integration suite has a Valkey logical database of its own, because they run at
 * the same time and flush theirs when they start: two suites sharing a number delete
 * each other's queues and sessions mid-run. A package's files may share its number only
 * when none of them flushes (the api's harness does, so each api file has its own). The
 * pre-push hook's end-to-end run (scripts/pre-push.ts) takes one too, and empties it first.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const files = Bun.spawnSync(
  ["git", "ls-files", "apps/*/test/*", "packages/*/test/*", "scripts/pre-push.ts"],
  {
    cwd: ROOT,
  },
)
  .stdout.toString()
  .split("\n")
  .filter((path) => /\.(ts|py)$/.test(path));

/**
 * Each file's database numbers: `startApi(n)`, `redisDatabase(n)`, Python's `path="/n"`,
 * and a URL's `pathname = "/n"`.
 */
const claims = files.flatMap((path) => {
  const text = readFileSync(join(ROOT, path), "utf8");
  return [
    ...text.matchAll(
      /(?:startApi|redisDatabase)\((\d+)|_replace\(path="\/(\d+)"\)|pathname = "\/(\d+)"/g,
    ),
  ].map((match) => ({
    path,
    pkg: path.split("/").slice(0, 2).join("/"),
    db: Number(match[1] ?? match[2] ?? match[3]),
    flushes: /flushdb\(\)|"flushdb"|flushTestDatabase\(|startApi\(/.test(text),
  }));
});

const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const databases = Number(/"--databases",\s*"(\d+)"/.exec(compose)?.[1]);

describe("Valkey databases in the tests", () => {
  it("are found", () => {
    expect(claims.length).toBeGreaterThan(10);
  });

  it("exist on the local and CI Valkey (docker-compose.yml)", () => {
    expect(claims.filter(({ db }) => db < 1 || db >= databases)).toEqual([]);
  });

  it("each belong to one package, and to one file where that file flushes it", () => {
    const clashes = claims.filter((claim) =>
      claims.some(
        (other) =>
          other.db === claim.db &&
          other.path !== claim.path &&
          (other.pkg !== claim.pkg || other.flushes || claim.flushes),
      ),
    );
    expect(clashes.map(({ path, db }) => `${path}: ${db}`)).toEqual([]);
  });
});
