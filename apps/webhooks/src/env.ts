/**
 * Validated environment for the webhooks service. Shared variables come from
 * @repo/nest-common's fragments; add new ones here, to .env.example and to
 * docs/environment.md.
 */

import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { coreEnv, csv, databaseEnv, port, redisEnv, withServicePort } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

const positive = z.coerce.number().int().positive();

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("WEBHOOKS"),
  ...redisEnv,
  // Receives provider webhooks at /webhooks/<provider>; also serves health checks.
  PORT: port(3004),

  // Decrypts endpoint signing secrets (the same keys apps/api encrypts them with).
  ENCRYPTION_KEYS: z.string().min(1),

  // Optional: Stripe's endpoint signing secret; /webhooks/stripe answers 404 without it.
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
  // Optional: the signature key of our Stalwart mail server's webhook (hard bounces
  // become suppressions); /webhooks/stalwart answers 404 without it. Comma-separated to
  // accept a new and an old key at once while rotating: Stalwart signs with one.
  STALWART_WEBHOOK_SECRET: csv.pipe(z.array(z.string().min(32)).min(1)).optional(),

  WEBHOOK_DELIVERY_CONCURRENCY: positive.default(20),
  WEBHOOK_TIMEOUT_MS: positive.max(MINUTE_MS).default(15 * SECOND_MS),
  // An endpoint failing for this long without a single success is disabled.
  WEBHOOK_AUTO_DISABLE_HOURS: positive.default(120),
  // Exact private IPs endpoints may point to, for local development and tests only
  // (e.g. "127.0.0.1"). Refused in production: customer URLs must be public.
  WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: csv.prefault(""),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("WEBHOOKS"),
  emptyStringAsUndefined: true,
});

if (env.NODE_ENV === "production" && env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES.length > 0) {
  throw new Error("WEBHOOK_ALLOWED_PRIVATE_ADDRESSES must be empty in production");
}
