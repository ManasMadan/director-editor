/**
 * Idempotency for mutations that must not run twice (payments, sends, expensive jobs).
 *
 *   const result = await idempotency.run(`${userId}:${idempotencyKey}`, chargeSchema, () =>
 *     billing.charge(...),
 *   );
 *
 * The first call runs the operation and stores its result for 24 hours; a retry with
 * the same key (the client lost the response, a proxy retried) gets the stored result
 * without running it again. A duplicate arriving while the first is still running is
 * rejected as a conflict rather than executed concurrently. Failures are not stored,
 * so a failed attempt can be retried with the same key.
 *
 * Keys must be scoped to the caller (user or org) so one tenant cannot replay another's.
 * A replayed result is parsed with the caller's schema: one that no longer matches fails
 * the request rather than run the operation twice or return the wrong type.
 */

import { DAY_S } from "@repo/contracts/time";
import type { Redis } from "ioredis";
import * as z from "zod";
import { AppError } from "./errors";

const TTL_SECONDS = DAY_S;
const LOCK_SECONDS = 60;

/** What the store keeps under a key: the claim, then the result. Null once it's expired. */
const stored = z
  .object({ state: z.enum(["running", "done"]), result: z.unknown().optional() })
  .nullable();

export class IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  private key(key: string) {
    return `idem:${key}`;
  }

  async run<T>(key: string, schema: z.ZodType<T>, operation: () => Promise<T>): Promise<T> {
    const redisKey = this.key(key);
    const claimed = await this.redis.set(
      redisKey,
      JSON.stringify({ state: "running" }),
      "EX",
      LOCK_SECONDS,
      "NX",
    );
    if (!claimed) {
      // A lock that expired just now reads as null: still no result to replay.
      const record = stored.parse(JSON.parse(String(await this.redis.get(redisKey))));
      if (record?.state === "done") {
        return schema.parse(record.result);
      }
      throw new AppError("IDEMPOTENCY_IN_PROGRESS");
    }
    try {
      const result = await operation();
      await this.redis.set(redisKey, JSON.stringify({ state: "done", result }), "EX", TTL_SECONDS);
      return result;
    } catch (error) {
      await this.redis.del(redisKey);
      throw error;
    }
  }
}
