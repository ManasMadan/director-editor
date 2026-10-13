/**
 * Validated environment for the API service. Shared variables come from
 * @repo/nest-common's fragments. Import `env` instead of reading `process.env`: a missing
 * or malformed value stops the process at boot with a readable message.
 *
 * Optional subsystems (Google sign-in, AI, captcha, ...) are enabled by setting their
 * variables; see src/features.ts. Add new variables here, to .env.example and to
 * docs/environment.md in the same change.
 */
import {
  asError,
  coreEnv,
  csv,
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
  // Optional: file uploads (profile pictures), on when S3_BUCKET is set.
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
   * Other origins of this product that may sign users in (comma-separated): the mobile
   * app's web build, for example. Native apps need nothing here (their scheme is
   * trusted by the Expo plugin).
   */
  APP_ORIGINS: csv.prefault("").pipe(z.array(z.url())),

  /**
   * SHA-256 fingerprints of the Android app's signing certificates (comma-separated,
   * AB:CD:...), the same as the web app's. A passkey made in the app is signed for the
   * app, not the site, so these are origins passkeys may come from (src/auth/auth.ts).
   */
  ANDROID_CERT_FINGERPRINTS: csv
    .prefault("")
    .pipe(
      z.array(z.string().regex(/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/, "a SHA-256 fingerprint")),
    ),

  /**
   * Optional: the cluster's Alertmanager, which `system.alerting` asks whether Prometheus's
   * Watchdog alert is still arriving (src/modules/system/alerting.ts). Unset: `off`.
   */
  ALERTMANAGER_URL: z.url().optional(),

  /** Oldest web/mobile app version still supported; older clients get CLIENT_OUTDATED. */
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
  // Browser push: the public half of apps/notifications' VAPID key pair.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  // Optional: billing (Stripe). On when STRIPE_SECRET_KEY is set, with both prices.
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(sk|rk)_(test|live)_/)
    .optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith("price_").optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().startsWith("price_").optional(),
  // Free trial for an organization's first subscription; 0 turns trials off.
  STRIPE_TRIAL_DAYS: z.coerce.number().int().min(0).max(730).default(14),
  // Test hook: where Stripe's API lives (packages/fake-stripe).
  STRIPE_API_URL: z.url().optional(),
  // Checks one-click unsubscribe links (apps/notifications signs them with the same secret).
  UNSUBSCRIBE_SECRET: z.string().min(32),
  // Encrypts webhook signing secrets at rest (apps/webhooks decrypts them to sign).
  ENCRYPTION_KEYS: z.string().min(1),
  // Exact private IPs webhook endpoints may use, for local development and tests only.
  WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: csv.prefault(""),
  // Optional: the Python AI service, and the secret this API signs its calls with
  // (the same AI_SERVICE_SECRET the service verifies with).
  AI_URL: z.url().optional(),
  AI_SERVICE_SECRET: z.string().min(32).optional(),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("API"),
  emptyStringAsUndefined: true,
});

export type Env = typeof env;

if (env.NODE_ENV === "production" && env.STRIPE_API_URL) {
  throw new Error("STRIPE_API_URL is for tests only");
}

if (env.NODE_ENV === "production" && env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES.length > 0) {
  throw new Error("WEBHOOK_ALLOWED_PRIVATE_ADDRESSES must be empty in production");
}
