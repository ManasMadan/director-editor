/**
 * The JavaScript a browser downloads before a page can run (its first load), per route,
 * gzipped, against a budget: `bun run --cwd apps/web budget` after `next build` (CI runs
 * it after the end-to-end suite). A route over budget fails the run; so does the shared
 * part (what every route loads) growing past its own.
 *
 * Raise a budget only on purpose, in the same change that needs it, and say why. Most
 * growth is a dependency pulled into a client component that could stay on the server or
 * load lazily (`next/dynamic`).
 *
 * It reads Next.js's build manifests, which aren't a public API: a Next release that
 * changes them fails this with a message saying what's missing, rather than measuring
 * nothing and passing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import * as z from "zod";
import { ROOT, runMain } from "./lib";

/**
 * Budgets in kB, gzipped: today's sizes plus a little room. A page with no forms loads
 * about 310 kB (React and Next are two thirds of it); pages with forms add up to about
 * 90 kB, mostly zod and react-hook-form. Two things keep it there: our packages declare
 * no side effects (so barrels only bring what's used), and code that reaches the browser
 * imports `* as z from "zod"` (biome refuses `import { z }`, which ships all of zod).
 */
export const SHARED_BUDGET = 135;
export const ROUTE_BUDGET = 410;

const changed = (what: string) =>
  new Error(`Next.js's build output changed: ${what}. Update scripts/bundle-budget.ts to read it.`);

/** Every route's client-reference manifest (server/app/**\/page_client-reference-manifest.js). */
function manifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return manifests(path);
    }
    return entry.name === "page_client-reference-manifest.js" ? [path] : [];
  });
}

const clientManifest = z.object({ entryJSFiles: z.record(z.string(), z.array(z.string())) });
const buildManifest = z.object({ rootMainFiles: z.array(z.string()).nonempty() });

/** A route's own chunks. The manifest is a script assigning one JSON object: `… = {…};`. */
function entryFiles(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("= {");
  if (start === -1) {
    throw changed(`${path} no longer assigns a JSON object`);
  }
  const manifest = clientManifest.safeParse(
    JSON.parse(source.slice(start + 2, source.lastIndexOf("}") + 1)),
  );
  if (!manifest.success) {
    throw changed(`${path} has no entryJSFiles`);
  }
  return Object.values(manifest.data.entryJSFiles).flat();
}

/** First-load sizes in kB, gzipped, of the build in `next` (a `.next` folder). */
export function firstLoad(next: string) {
  const sizes = new Map<string, number>();
  const gzipped = (file: string) => {
    let size = sizes.get(file);
    if (size === undefined) {
      size = gzipSync(readFileSync(join(next, file))).length;
      sizes.set(file, size);
    }
    return size;
  };
  const total = (files: Set<string>) => [...files].reduce((sum, f) => sum + gzipped(f), 0) / 1024;

  const build = buildManifest.safeParse(
    JSON.parse(readFileSync(join(next, "build-manifest.json"), "utf8")),
  );
  if (!build.success) {
    throw changed("build-manifest.json lists no rootMainFiles");
  }
  const shared = new Set(build.data.rootMainFiles);
  const app = join(next, "server/app");
  const routes = manifests(app)
    .map((path) => {
      const route = `/${relative(app, path)}`.replace(/\/?page_client-reference-manifest\.js$/, "");
      return { route: route || "/", size: total(new Set([...shared, ...entryFiles(path)])) };
    })
    .sort((a, b) => b.size - a.size);
  if (routes.length === 0) {
    throw new Error("No routes found: run `next build` first.");
  }
  return { shared: total(shared), routes };
}

/** Prints each size against its budget; the exit code. */
export function main(next = join(ROOT, "apps/web/.next"), log = console.log): number {
  const { shared, routes } = firstLoad(next);
  let over = false;
  const line = (label: string, size: number, budget: number) => {
    const failed = size > budget;
    over ||= failed;
    log(
      `  ${failed ? "✖" : "✔"} ${label.padEnd(48)} ${size.toFixed(1).padStart(7)} kB / ${budget} kB`,
    );
  };
  log("First-load JavaScript, gzipped:");
  line("shared by every route", shared, SHARED_BUDGET);
  for (const { route, size } of routes) {
    line(route, size, ROUTE_BUDGET);
  }
  if (!over) {
    return 0;
  }
  log("\nOver budget: see scripts/bundle-budget.ts.");
  return 1;
}

await runMain(import.meta, main);
