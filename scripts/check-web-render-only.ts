/**
 * The web app renders UI only; all backend logic lives in apps/api. Next.js makes it
 * easy to slip server code in anyway (route handlers, server actions), so CI fails on
 * either. The allowed route handlers answer from configuration alone: the Kubernetes
 * health probe, and the mobile app's association files (apps/web/src/lib/app-links.ts),
 * which iOS and Android fetch from fixed paths.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { fail, ok, ROOT, runMain } from "./lib";

const ALLOWED_ROUTES = new Set([
  "app/healthz/route.ts",
  "app/.well-known/apple-app-site-association/route.ts",
  "app/.well-known/assetlinks.json/route.ts",
]);

/** Reports each piece of server code in the web app's source at `web`; the exit code. */
export function checkWebRenderOnly(web = join(ROOT, "apps/web/src")): number {
  let violations = 0;

  // Dot directories too: Next serves app/.well-known/ like any other folder.
  for (const file of new Glob("app/**/route.{ts,tsx}").scanSync({ cwd: web, dot: true })) {
    if (!ALLOWED_ROUTES.has(file)) {
      violations += 1;
      fail(
        `apps/web/src/${file}: route handlers are not allowed; add an API procedure in apps/api instead.`,
      );
    }
  }

  for (const file of new Glob("**/*.{ts,tsx}").scanSync({ cwd: web, dot: true })) {
    const source = readFileSync(join(web, file), "utf8");
    if (/^\s*["']use server["']/m.test(source)) {
      violations += 1;
      fail(
        `apps/web/src/${file}: server actions ("use server") are not allowed; call the API instead.`,
      );
    }
  }

  for (const file of new Glob("pages/api/**/*").scanSync(web)) {
    violations += 1;
    fail(`apps/web/src/${file}: Pages Router API routes are not allowed.`);
  }

  if (violations) {
    return 1;
  }
  ok("web app is render-only");
  return 0;
}

await runMain(import.meta, checkWebRenderOnly);
