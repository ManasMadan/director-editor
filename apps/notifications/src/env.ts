/**
 * Validated environment for the notification service. Shared variables come from
 * @repo/nest-common's fragments; add new ones here, to .env.example and to
 * docs/environment.md.
 */
import {
  coreEnv,
  databaseEnv,
  port,
  redisEnv,
  requiredInProduction,
  withServicePort,
} from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";
import { productionSmtpProblem } from "./channels/email/smtp-url";

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("NOTIFICATIONS"),
  ...redisEnv,
  // Only serves health checks; the work arrives through the queues.
  PORT: port(3003),

  // Jobs one process handles at once. Scale out with more replicas.
  NOTIFICATIONS_CRITICAL_CONCURRENCY: z.coerce.number().int().positive().default(20),

  // Where email is submitted: our Stalwart mail server in production (authenticated,
  // over TLS: see channels/email/smtp-url.ts), Mailpit locally.
  SMTP_URL: requiredInProduction(
    z.url({ protocol: /^smtps?$/ }).superRefine((value, context) => {
      const problem =
        process.env.NODE_ENV === "production" ? productionSmtpProblem(value) : undefined;
      if (problem) {
        context.addIssue({ code: "custom", message: problem });
      }
    }),
    "smtp://localhost:51025",
  ),
  EMAIL_FROM: requiredInProduction(z.string().min(3), "Director <no-reply@localhost>"),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("NOTIFICATIONS"),
  emptyStringAsUndefined: true,
});
