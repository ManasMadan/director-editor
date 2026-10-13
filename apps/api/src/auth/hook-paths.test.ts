/**
 * The auth hooks, audit mapping and security alerts recognise better-auth endpoints by
 * path. A path renamed in an upgrade would silently drop the alert or audit event, so
 * every path they name must still be one of the endpoints this configuration serves.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auth } from "./auth.cli";

const endpoints = Object.values(auth.api).flatMap((endpoint) =>
  typeof endpoint === "function" && "path" in endpoint ? [String(endpoint.path)] : [],
);
const sources = readdirSync(import.meta.dirname)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => [file, readFileSync(join(import.meta.dirname, file), "utf8")] as const);
const named = (pattern: RegExp) =>
  sources.flatMap(([file, text]) =>
    [...text.matchAll(pattern)].map((match) => `${file}: ${match[1]}`),
  );

describe("the better-auth paths the hooks name", () => {
  it("are all endpoints", () => {
    // `case "/x"`, `path === "/x"`, and a handler table's `"/x": (...) =>` keys.
    const paths = named(/(?:case |path === |^\s*(?="\/[^"]*": \())"(\/[^"]*)"/gm);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((entry) => !endpoints.includes(entry.split(": ")[1] as string))).toEqual(
      [],
    );
  });

  it("start endpoints, where they name a prefix", () => {
    const prefixes = named(/startsWith\("(\/[^"]*)"\)/g);
    expect(prefixes.length).toBeGreaterThan(3);
    const unknown = prefixes.filter((entry) => {
      const prefix = entry.split(": ")[1] as string;
      return !endpoints.some((path) => path.startsWith(prefix));
    });
    expect(unknown).toEqual([]);
  });
});
