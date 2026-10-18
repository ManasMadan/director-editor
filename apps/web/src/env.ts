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
  // When file uploads are on: the object storage origin browsers upload to and load
  // files from (presigned URLs), allowed by the Content-Security-Policy.
  STORAGE_ORIGIN: z.url().optional(),
};

export const env = createEnv({
  server: envSchema,
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
  // Only for generating route types (`check-types`), which loads next.config.ts but never
  // serves a request. Builds and servers always validate.
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
