/**
 * `output: "standalone"` builds a self-contained server but leaves the static assets
 * (and public/) for the host to serve. Copying them next to the server makes
 * `bun run start` and the Docker image serve them the same way, from the same place.
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Copies the build in `dir`'s static assets and public/ next to its standalone server. */
export function copyStatic(dir = ".") {
  const target = join(dir, ".next/standalone/apps/web");
  cpSync(join(dir, ".next/static"), join(target, ".next/static"), { recursive: true });
  if (existsSync(join(dir, "public"))) {
    cpSync(join(dir, "public"), join(target, "public"), { recursive: true });
  }
}

// Run as `bun run scripts/copy-static.ts` in apps/web, not when a test imports it.
import.meta.main && copyStatic();
