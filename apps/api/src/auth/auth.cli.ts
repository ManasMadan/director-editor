/**
 * Entry point for better-auth's CLI (`auth generate`), which reads the configuration to
 * produce the auth tables. It builds the real configuration with inert dependencies:
 * nothing connects to Postgres or Redis and nothing is sent. Rows go to an in-memory
 * store, so nothing needs the tables being generated. `--adapter prisma` picks the output
 * format. (better-auth warns that the in-memory store generates no ids; nothing is kept,
 * so that's expected.)
 * Used by the db-change skill: `bun run auth:schema`.
 */

import { createDb } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Redis } from "ioredis";
import type { RecordActivity } from "../activity";
import { env } from "../env";
import { createAuth } from "./auth";
import { createMemberships } from "./memberships";

/** What the configuration would send, change or log through: refusing, or doing nothing. */
export const inert = {
  notifications: {
    add: (..._job: Parameters<Producer<"notifications-critical">["add"]>) =>
      Promise.reject(new Error("The auth CLI never sends notifications")),
  },
  // Nobody signs in through the CLI, so there's no activity to log.
  activity: ((_activity) => undefined) satisfies RecordActivity,
};

const db = createDb({ url: env.API_DATABASE_URL, poolMax: 1, service: "auth-cli" });
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

export const auth = createAuth({
  env,
  db,
  redis,
  notifications: inert.notifications,
  memberships: createMemberships(db, redis),
  activity: inert.activity,
  database: memoryAdapter({}),
});
