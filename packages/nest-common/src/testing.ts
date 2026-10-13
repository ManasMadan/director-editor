/**
 * Helpers for integration tests (not part of the runtime surface).
 */

import { required } from "@repo/contracts/objects";
import type { Redis } from "ioredis";

/**
 * The local Redis/Valkey at REDIS_URL, but a specific logical database, so a test
 * suite never shares queues or sessions with the dev stack or another suite.
 * docs/testing.md lists who has which; scripts/redis-databases.test.ts keeps them apart.
 */
export function redisDatabase(index: number): string {
  // Always set in tests: every vitest config applies .env.example's values.
  const url = new URL(required(process.env.REDIS_URL, "REDIS_URL"));
  url.pathname = `/${index}`;
  return url.toString();
}

/**
 * Empties the suite's own database. A number the server doesn't have leaves ioredis on
 * database 0 (it logs the refusal and carries on), which is the dev stack's: this checks
 * where the connection really is before flushing, and refuses 0.
 */
export async function flushTestDatabase(redis: Redis) {
  const info = String(await redis.call("CLIENT", "INFO"));
  // CLIENT INFO always names the connection's database; anything else reads as 0.
  const db = Number(info.replace(/^.*\bdb=(\d+).*$/s, "$1"));
  if (!db) {
    throw new Error(
      "Refusing to flush Valkey database 0, the dev stack's: the suite's own database doesn't exist. Recreate Valkey with the databases docker-compose.yml asks for (`docker compose up -d valkey`).",
    );
  }
  await redis.flushdb();
}
