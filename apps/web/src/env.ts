/**
 * The web server's configuration, validated when the app starts and when it builds
 * (next.config.ts imports this), so a missing or malformed value fails immediately.
 * Every variable is server-only: the browser never needs configuration, because the API
 * is on the same origin.
 */
import { createEnv } from "@t3-oss/env-nextjs";
import * as z from "zod";

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  // This site's public origin (canonical URLs, sitemap).
  WEB_URL: z.url(),
  // Where /rpc and /api are forwarded in local development (the gateway does it when deployed).
  API_URL: z.url().default("http://localhost:3001"),
  // Where /ai/mcp (the Python service's MCP server) is forwarded in local development.
  AI_URL: z.url().optional(),
  // When file uploads are on: the object storage origin browsers upload to and load
  // files from (presigned URLs), allowed by the Content-Security-Policy.
  STORAGE_ORIGIN: z.url().optional(),
  // The mobile app this site opens https links in (universal links, App Links) and shares
  // passkeys with: src/lib/app-links.ts serves its association files from them. Optional:
  // all four or none (a partial set stops the server, src/instrumentation.ts).
  APPLE_TEAM_ID: z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "the 10-character team id from Apple's developer account")
    .optional(),
  IOS_BUNDLE_ID: z
    .string()
    .regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/, "a bundle id, e.g. com.boilerplate.app")
    .optional(),
  ANDROID_PACKAGE: z
    .string()
    .regex(/^[A-Za-z]\w*(\.[A-Za-z]\w*)+$/, "a package name, e.g. com.boilerplate.app")
    .optional(),
  // Comma-separated SHA-256 fingerprints of the certificates the Android app is signed
  // with (AB:CD:...): Play's app signing key, and the upload key for builds installed
  // outside the store.
  ANDROID_CERT_FINGERPRINTS: z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim().toUpperCase()))
    .pipe(
      z.array(z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, "a SHA-256 fingerprint")).min(1),
    )
    .optional(),
};

export const env = createEnv({
  server: envSchema,
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
  // Only for generating route types (`check-types`), which loads next.config.ts but never
  // serves a request. Builds and servers always validate.
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
