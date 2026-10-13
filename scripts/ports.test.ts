/**
 * Every local port has one home, its `*_PORT` in .env.example. The services' schemas
 * (apps/<service>/src/env.ts) and docker-compose.yml (`${VAR:-default}`) repeat a default
 * for when the variable is unset; everything else that starts or reaches something
 * locally reads the variable, so `bun run setup --stack <n>` moves it and two checkouts
 * run side by side. A fixed port is right only where the list below says why.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { defaultPorts } from "../packages/testing/src/stack";

const ROOT = join(import.meta.dir, "..");
const example = parseEnv(readFileSync(join(ROOT, ".env.example"), "utf8"));
const PORTS = new Set(Object.values(defaultPorts(example as Record<string, string>)).map(String));

/** Where a fixed port is right. */
const FIXED_PORTS_ALLOWED = [
  // The defaults themselves, and the schemas' for an unset variable.
  /^\.env\.example$/,
  /^apps\/[^/]+\/src\/env\.ts$/,
  // Clusters and images: the charts set PORT, each image has its own.
  /^deploy\//,
  /^scripts\/image-smoke\.ts$/,
  // CI's own services, one run per machine; a dev container holds one checkout.
  /^\.github\//,
  /^\.devcontainer\//,
  // Docs name the defaults; tests use them as data.
  /\.md$/,
  /(^|\/)(test|tests|e2e|maestro)\//,
  /\.test\.tsx?$/,
  // Sample links in the email previews (packages/email `dev`).
  /^packages\/email\/src\/previews\//,
  // Lockfiles and generated code.
  /(^|\/)(bun|uv)\.lock$/,
  /\/generated\//,
];

/** A port number where a local address or a port option names it. */
const NAMED_PORT =
  /(?:(?:localhost|127\.0\.0\.1|host\.docker\.internal):|port[^\w\n]{1,6}|\s-p\s+)(\d{2,5})(?!\d)/gi;

/** Each `file:line` that fixes one of .env.example's ports. */
function fixedPorts(path: string, text: string): string[] {
  if (FIXED_PORTS_ALLOWED.some((pattern) => pattern.test(path))) {
    return [];
  }
  return text.split("\n").flatMap((written, index) => {
    // Comments describe the defaults.
    if (/^\s*(#|\/\/|\*|\/\*)/.test(written)) {
      return [];
    }
    // docker compose's own fallback for an unset variable (`${WEB_URL:-http://...}`).
    const line = path === "docker-compose.yml" ? written.replace(/:-[^}]*\}/g, "}") : written;
    return [...line.matchAll(NAMED_PORT)]
      .filter((match) => PORTS.has(match[1] ?? ""))
      .map((match) => `${path}:${index + 1}: ${match[0].trim()}`);
  });
}

describe("local ports", () => {
  it("are fixed nowhere but .env.example and the defaults that fall back to it", () => {
    const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
      .stdout.toString()
      .split("\n")
      .filter(Boolean);
    const found = tracked.flatMap((path) => {
      const text = readFileSync(join(ROOT, path), "utf8");
      return text.includes("\0") ? [] : fixedPorts(path, text);
    });
    expect(found).toEqual([]);
  });
});
