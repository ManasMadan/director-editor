/**
 * The day's allowance of videos Director sends to YouTube, across every member
 * (PUBLISH_DAILY_LIMIT, a day as YouTube's quota counts it: midnight to midnight
 * Pacific time, quota-day.ts): each upload costs a large share of the project's daily
 * YouTube Data API quota, which indexing's reads draw on too, so a few busy members
 * must not spend it for everyone. One counter per day in Redis, taken with an atomic
 * INCR that also sets it to expire when YouTube's day ends; a place is given back only
 * while nothing has reached YouTube.
 */
import { Injectable } from "@nestjs/common";
import { PUBLISH_DAILY_LIMIT } from "@repo/contracts/api";
import {
  AppError,
  describeError,
  InjectPinoLogger,
  InjectRedis,
  PinoLogger,
  type Redis,
} from "@repo/nest-common";
import * as z from "zod";
import { nextQuotaDay, quotaDay } from "./quota-day";

/** The day's counter, by YouTube's quota day (a Pacific time date). */
const keyOf = (now: Date) => `publish:uploads:${quotaDay(now)}`;

// What MULTI answers for INCR then EXPIREAT: each command's error (none) and reply.
const taken = z.tuple([
  z.tuple([z.null(), z.number().int()]),
  z.tuple([z.null(), z.number().int()]),
]);

@Injectable()
export class DailyAllowance {
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectPinoLogger(DailyAllowance.name) private readonly log: PinoLogger,
  ) {}

  /**
   * Takes one of the day's places, or refuses with PUBLISH_QUOTA_EXHAUSTED when they're
   * all taken. Returns the day it was taken on, to give it back on.
   */
  async take(now = new Date()) {
    const key = keyOf(now);
    const [[, count]] = taken.parse(
      await this.redis.multi().incr(key).expireat(key, nextQuotaDay(now)).exec(),
    );
    if (count > PUBLISH_DAILY_LIMIT) {
      await this.redis.decr(key);
      throw new AppError("PUBLISH_QUOTA_EXHAUSTED");
    }
    return now;
  }

  /**
   * Gives back a place taken on `day`, when nothing reached YouTube after all. Never
   * throws: a place it can't give back is logged, and the day's count stays one higher
   * until YouTube's day ends, which is the safe way to be wrong.
   */
  async giveBack(day: Date) {
    const key = keyOf(day);
    try {
      // With its expiry again: a day that has ended by now mustn't leave a key behind.
      await this.redis.multi().decr(key).expireat(key, nextQuotaDay(day)).exec();
    } catch (error) {
      this.log.warn({ err: describeError(error), key }, "couldn't give back a publish place");
    }
  }

  /**
   * Runs `claim` holding a place taken on `day`, and gives the place back when the claim
   * answers false (another publish has the cut) or throws.
   */
  async keepIf(day: Date, claim: () => Promise<boolean>) {
    let kept = false;
    try {
      kept = await claim();
      return kept;
    } finally {
      if (!kept) {
        await this.giveBack(day);
      }
    }
  }
}
