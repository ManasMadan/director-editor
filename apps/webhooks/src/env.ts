/**
 * Validated environment for the webhooks service. Shared variables come from
 * @repo/nest-common's fragments; add new ones here, to .env.example and to
 * docs/environment.md.
 */

import { coreEnv, csv, databaseEnv, port, redisEnv, withServicePort } from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("WEBHOOKS"),
  ...redisEnv,
  // Receives provider webhooks at /webhooks/<provider>; also serves health checks.
  PORT: port(3004),

  // Optional: the signature key of our Stalwart mail server's webhook (hard bounces
  // become suppressions); /webhooks/stalwart answers 404 without it. Comma-separated to
  // accept a new and an old key at once while rotating: Stalwart signs with one.
  STALWART_WEBHOOK_SECRET: csv.pipe(z.array(z.string().min(32)).min(1)).optional(),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("WEBHOOKS"),
  emptyStringAsUndefined: true,
});
