/**
 * Validated environment for the API service. Shared variables come from
 * @repo/nest-common's fragments. Import `env` instead of reading `process.env`: a missing
 * or malformed value stops the process at boot with a readable message.
 *
 * Optional subsystems (Google sign-in, AI, captcha, ...) are enabled by setting their
 * variables; see src/features.ts. Add new variables here, to .env.example and to
 * docs/environment.md in the same change.
 */

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@repo/contracts/auth-settings";
import {
  asError,
  coreEnv,
  databaseEnv,
  port,
  redisEnv,
  storageEnv,
  withServicePort,
} from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";
import { parseAuthSecrets } from "./auth/secrets";

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("API"),
  ...redisEnv,
  // Optional: file uploads (profile pictures, Director's takes), on when the chosen
  // STORAGE_PROVIDER has its bucket (filesEnabled in @repo/nest-common).
  ...storageEnv,
  PORT: port(3001),

  BETTER_AUTH_SECRET: z.string().min(32, "Generate one with: openssl rand -base64 32"),
  /** Optional: versioned secrets for rotating BETTER_AUTH_SECRET (src/auth/secrets.ts). */
  BETTER_AUTH_SECRETS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) {
        return undefined;
      }
      try {
        return parseAuthSecrets(value);
      } catch (error) {
        ctx.addIssue({ code: "custom", message: asError(error).message });
        return z.NEVER;
      }
    }),
  /** Public URL of this API; OAuth callbacks and cookies are derived from it. */
  BETTER_AUTH_URL: z.url(),
  /** Public URL of the web app, the browser origin allowed to call the API. */
  WEB_URL: z.url(),
  /**
   * Optional: the cluster's Alertmanager, which `system.alerting` asks whether Prometheus's
   * Watchdog alert is still arriving (src/modules/system/alerting.ts). Unset: `off`.
   */
  ALERTMANAGER_URL: z.url().optional(),

  /** Oldest app version still supported; older clients get CLIENT_OUTDATED. */
  MINIMUM_CLIENT_VERSION: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "major.minor.patch")
    .default("0.0.0"),

  // Optional: Google sign-in.
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  // Optional: Cloudflare Turnstile on sign-up, emailed codes and password reset. The
  // site key is public (browsers render the widget with it); the secret stays here.
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  // Refuse passwords found in public breaches (Have I Been Pwned, k-anonymity: only a
  // hash prefix leaves). On by default in production only, so local runs and the tests
  // never depend on the internet. While it's on and HIBP is unreachable, sign-ups and
  // password changes fail (a breached password is never let through unchecked).
  PASSWORD_BREACH_CHECK: z
    .enum(["on", "off"])
    .default(process.env.NODE_ENV === "production" ? "on" : "off"),
  // Optional: Director's shared demo account (src/auth/demo.ts). Its password,
  // which `bun run --filter @repo/api director:demo-account` gives the account and
  // `system.info` shows on the sign-in page, on purpose: anyone may try Director with it.
  // Unset: no demo account is offered.
  DEMO_PASSWORD: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
  // Optional: the Python AI service, and the secret this API signs its calls with
  // (the same AI_SERVICE_SECRET the service verifies with).
  AI_URL: z.url().optional(),
  AI_SERVICE_SECRET: z.string().min(32).optional(),
  // Optional: checks a pasted Shorts link (YouTube Data API v3). Director is on when it and
  // the AI service are both set (src/features.ts).
  YOUTUBE_API_KEY: z.string().min(1).optional(),
  // Test hook: where YouTube's API lives (the tests' stand-in).
  YOUTUBE_API_URL: z.url().default("https://www.googleapis.com/youtube/v3"),
  // Optional: Director's live video call (Gemini Live on Vertex AI, /api/live). On when
  // the Google Cloud project is set; the machine's service account pays for the calls.
  GOOGLE_CLOUD_PROJECT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "a Google Cloud project id")
    .optional(),
  /** The Vertex AI region the calls go to (it names the endpoint's host). */
  LIVE_LOCATION: z
    .string()
    .regex(/^[a-z]+-[a-z]+\d+$/, "a Vertex AI region, e.g. us-central1")
    .default("us-central1"),
  /** The Live API model, by its Vertex AI name. */
  LIVE_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*$/, "a model name")
    .default("gemini-live-2.5-flash-native-audio"),
  // Local development only: a Google access token (`gcloud auth print-access-token`) in
  // place of the GCE metadata server's. Production refuses it.
  GOOGLE_ACCESS_TOKEN: z.string().min(1).optional(),
  // Optional: product analytics (src/modules/analytics), streamed into this BigQuery
  // dataset's `events` table for a Looker Studio report. Reuses GOOGLE_CLOUD_PROJECT,
  // above. Unset: analytics is off, nothing is written anywhere.
  BIGQUERY_DATASET: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,1024}$/, "a BigQuery dataset name (letters, digits, underscores)")
    .optional(),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("API"),
  emptyStringAsUndefined: true,
});

export type Env = typeof env;

// The local mock Google (packages/fake-google) is plain HTTP: production never reads it.
if (env.NODE_ENV === "production" && !env.YOUTUBE_API_URL.startsWith("https://")) {
  throw new Error("YOUTUBE_API_URL must be HTTPS in production");
}

// A pasted token expires within the hour; production uses the machine's service account.
if (env.NODE_ENV === "production" && env.GOOGLE_ACCESS_TOKEN) {
  throw new Error("GOOGLE_ACCESS_TOKEN is for local development only");
}
