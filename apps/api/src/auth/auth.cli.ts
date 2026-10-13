/**
 * Entry point for better-auth's CLI (`auth generate`), which reads the configuration to
 * produce the auth tables. It builds the real configuration with inert dependencies:
 * nothing connects to Postgres or Redis and nothing is sent. Rows go to an in-memory
 * store: plugins that write at startup (the OAuth provider seeds its resources) must not
 * need the tables being generated. `--adapter prisma` picks the output format. (better-auth
 * warns that the in-memory store generates no ids; nothing is kept, so that's expected.)
 * Used by the db-change skill: `bun run auth:schema`.
 */

import { unlimited } from "@repo/contracts/billing";
import { createDb } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Redis } from "ioredis";
import { env } from "../env";
import { createAuth } from "./auth";
import { createMemberships } from "./memberships";

/** What the configuration would send or change through, all refusing. */
export const inert = {
  notifications: {
    add: (..._job: Parameters<Producer<"notifications-critical">["add"]>) =>
      Promise.reject(new Error("The auth CLI never sends notifications")),
  },
  billing: {
    entitlements: async () => unlimited,
    cancelFor: () => Promise.reject(new Error("The auth CLI never changes billing")),
  },
};

const db = createDb({ url: env.API_DATABASE_URL, poolMax: 1, service: "auth-cli" });
const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

export const auth = createAuth({
  env,
  db,
  redis,
  notifications: inert.notifications,
  memberships: createMemberships(db, redis),
  billing: inert.billing,
  // The only table written at startup: the OAuth provider seeds its resources.
  database: memoryAdapter({ oauthResource: [] }),
});
