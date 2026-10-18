/**
 * Validated environment for the worker. Shared variables come from @repo/nest-common's
 * fragments; add new ones here, to .env.example and to docs/environment.md.
 */
import {
  coreEnv,
  databaseEnv,
  directDatabaseEnv,
  filesEnabled,
  port,
  redisEnv,
  storageEnv,
  withServicePort,
} from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

const positive = z.coerce.number().int().positive();

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("WORKER"),
  // LISTEN/NOTIFY needs a direct connection; a transaction-mode pooler drops it.
  ...directDatabaseEnv("WORKER"),
  ...redisEnv,
  // Only serves health checks.
  PORT: port(3002),

  // Outbox events claimed per transaction, and how often to look even without a NOTIFY.
  RELAY_BATCH_SIZE: positive.max(1000).default(100),
  RELAY_POLL_INTERVAL_MS: positive.default(1000),
  AUDIT_CONCURRENCY: positive.default(20),

  // Retention. Published outbox rows are the replay window for new consumers.
  OUTBOX_RETENTION_DAYS: positive.default(7),
  PROCESSED_EVENT_RETENTION_DAYS: positive.default(30),
  AUDIT_RETENTION_MONTHS: positive.default(13),
  // Received provider events (the mail server's).
  WEBHOOK_HISTORY_DAYS: positive.default(30),
  // The email delivery log.
  NOTIFICATION_HISTORY_DAYS: positive.default(90),

  // Uploads: checked here when files are on (the chosen STORAGE_PROVIDER has its bucket).
  ...storageEnv,
  FILES_CONCURRENCY: positive.default(2),
  // clamd for virus scanning; "none" skips scanning (development only).
  FILE_SCANNER: z.enum(["clamav", "none"]).default("clamav"),
  CLAMAV_URL: z.url({ protocol: /^tcp$/ }).default("tcp://localhost:53310"),

  // Director's continuous recording: each ended attempt is cut into a take through the AI
  // service (its clipper, on Cloud Run when it has CLIPPER_URL), which also records the
  // take. Both or neither, like the API's: without them recorded attempts wait.
  AI_URL: z.url().optional(),
  AI_SERVICE_SECRET: z.string().min(32).optional(),
  // Attempts cut at once per process: each holds a take (up to 15 MB) in memory.
  RECORDING_CONCURRENCY: positive.default(2),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("WORKER"),
  emptyStringAsUndefined: true,
});

// Asked in every environment, so a half-configured provider stops the worker at boot.
const files = filesEnabled(env);
if (env.NODE_ENV === "production" && files && env.FILE_SCANNER === "none") {
  throw new Error("FILE_SCANNER=none is for development only: uploads must be scanned");
}
