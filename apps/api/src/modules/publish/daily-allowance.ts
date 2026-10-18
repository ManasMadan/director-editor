/**
 * The day's allowance of videos Director sends to YouTube, across every member
 * (PUBLISH_DAILY_LIMIT, a UTC day): each upload costs a large share of the project's
 * daily YouTube Data API quota, which indexing's reads draw on too, so a few busy
 * members must not spend it for everyone. One counter per day in Redis, taken with an
 * atomic INCR that also sets it to expire at the next midnight UTC; a place is given
 * back when nothing reached YouTube after all.
 */
import { Injectable } from "@nestjs/common";
import { PUBLISH_DAILY_LIMIT } from "@repo/contracts/api";
import { DAY_S, SECOND_MS } from "@repo/contracts/time";
import { AppError, InjectRedis, type Redis } from "@repo/nest-common";
import * as z from "zod";

/** The day's counter, by its UTC date. */
const keyOf = (now: Date) => `publish:uploads:${now.toISOString().slice(0, 10)}`;

/** The next midnight UTC, in seconds since the epoch: when the day's counter expires. */
function nextMidnight(now: Date) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor(midnight / SECOND_MS) + DAY_S;
}

// What MULTI answers for INCR then EXPIREAT: each command's error (none) and reply.
const taken = z.tuple([
  z.tuple([z.null(), z.number().int()]),
  z.tuple([z.null(), z.number().int()]),
]);

@Injectable()
export class DailyAllowance {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Takes one of the day's places, or refuses with PUBLISH_QUOTA_EXHAUSTED when they're
   * all taken. Returns the day it was taken on, to give it back on.
   */
  async take(now = new Date()) {
    const key = keyOf(now);
    const [[, count]] = taken.parse(
      await this.redis.multi().incr(key).expireat(key, nextMidnight(now)).exec(),
    );
    if (count > PUBLISH_DAILY_LIMIT) {
      await this.redis.decr(key);
      throw new AppError("PUBLISH_QUOTA_EXHAUSTED");
    }
    return now;
  }

  /** Gives back a place taken on `day`, when nothing reached YouTube after all. */
  async giveBack(day: Date) {
    const key = keyOf(day);
    // With its expiry again: a day that has ended by now mustn't leave a key behind.
    await this.redis.multi().decr(key).expireat(key, nextMidnight(day)).exec();
  }
}
