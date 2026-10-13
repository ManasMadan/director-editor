import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { firstLoad, main } from "./bundle-budget";

/** A `.next` folder with the manifests Next.js writes, and chunks of random (incompressible) bytes. */
function build(files: Record<string, string | Buffer>) {
  const next = mkdtempSync(join(tmpdir(), "next-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(next, path)), { recursive: true });
    writeFileSync(join(next, path), content);
  }
  return next;
}
const chunk = (kB: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(kB * 1024)));
const manifest = (entryJSFiles: unknown) =>
  `globalThis.__RSC_MANIFEST["/page"] = ${JSON.stringify({ entryJSFiles })};`;
const app = (overrides: Record<string, string | Buffer> = {}) =>
  build({
    "build-manifest.json": JSON.stringify({ rootMainFiles: ["static/chunks/main.js"] }),
    "static/chunks/main.js": chunk(10),
    "static/chunks/settings.js": chunk(20),
    "server/app/page_client-reference-manifest.js": manifest({}),
    "server/app/settings/page_client-reference-manifest.js": manifest({
      "[project]/settings/page": ["static/chunks/settings.js", "static/chunks/main.js"],
    }),
    ...overrides,
  });

describe("the bundle budget", () => {
  it("adds each route's own chunks to the shared ones, counting each file once", () => {
    const { shared, routes } = firstLoad(app());
    expect(shared).toBeGreaterThan(10);
    expect(routes.map((route) => route.route)).toEqual(["/settings", "/"]);
    const [settings, home] = routes;
    expect(home?.size).toBe(shared);
    expect((settings?.size ?? 0) - shared).toBeGreaterThan(20);
  });

  it("fails on a Next.js build whose manifests it can no longer read", () => {
    expect(() => firstLoad(app({ "build-manifest.json": "{}" }))).toThrow(/no rootMainFiles/);
    expect(() =>
      firstLoad(app({ "server/app/page_client-reference-manifest.js": manifest(undefined) })),
    ).toThrow(/has no entryJSFiles/);
    expect(() =>
      firstLoad(app({ "server/app/page_client-reference-manifest.js": "export default []" })),
    ).toThrow(/no longer assigns a JSON object/);
  });

  it("asks for a build when there is none", () => {
    const next = build({
      "build-manifest.json": JSON.stringify({ rootMainFiles: ["main.js"] }),
      "main.js": "x",
      "server/app/.keep": "",
    });
    expect(() => firstLoad(next)).toThrow(/run `next build` first/);
  });

  it("passes within budget and fails a route over it", () => {
    const lines: string[] = [];
    expect(main(app(), (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toBe("First-load JavaScript, gzipped:");
    const big = app({ "static/chunks/settings.js": chunk(500) });
    expect(main(big, (line) => lines.push(line))).toBe(1);
    expect(lines.at(-1)).toContain("Over budget");
  });
});
