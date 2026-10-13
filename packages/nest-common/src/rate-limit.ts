/**
 * Rate limiting on Redis, shared by every replica.
 *
 *   const limiter = createRateLimiter(redis, { name: "sign-in", points: 5, windowSeconds: 60 });
 *   await limiter.take(`${ip}:${email}`); // throws RATE_LIMITED (with retryAfterSeconds) past it
 *   const result = await limiter.consume(key); // or look at the result yourself
 *
 * Keys are hashed into one Redis Cluster slot per limiter (`{rl:<name>}`) so the limiter
 * keeps working unchanged on a cluster. When Redis is unreachable the limiter fails
 * CLOSED for sensitive limiters (auth, AI) and OPEN for general traffic, per `onRedisError`:
 * an outage should not lock everyone out, nor open the door to credential stuffing.
 */
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { AppError } from "./errors";
import { describeError } from "./job-processor";

const log = new Logger("RateLimiter");
/** At most one log line per limiter this often, however many requests hit the outage. */
const OUTAGE_LOG_MS = 30_000;

export interface RateLimiterOptions {
  name: string;
  points: number;
  windowSeconds: number;
  /** What to do if Redis is down: "deny" for auth/AI, "allow" for general traffic. */
  onRedisError?: "deny" | "allow";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function createRateLimiter(redis: Redis, options: RateLimiterOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `{rl:${options.name}}`,
    points: options.points,
    duration: options.windowSeconds,
  });
  const failOpen = options.onRedisError === "allow";
  let loggedAt = Number.NEGATIVE_INFINITY;

  async function consume(key: string, cost = 1): Promise<RateLimitResult> {
    try {
      const res = await limiter.consume(key, cost);
      return { allowed: true, remaining: res.remainingPoints, retryAfterSeconds: 0 };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil(error.msBeforeNext / 1000),
        };
      }
      // Redis is failing: the limiter answers as configured, and says so.
      if (Date.now() - loggedAt >= OUTAGE_LOG_MS) {
        loggedAt = Date.now();
        log.error(
          {
            limiter: options.name,
            failing: failOpen ? "open" : "closed",
            err: describeError(error),
          },
          "rate limiter can't reach Redis",
        );
      }
      if (failOpen) {
        return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
      }
      return { allowed: false, remaining: 0, retryAfterSeconds: options.windowSeconds };
    }
  }

  return {
    consume,
    /** Consumes, or throws RATE_LIMITED (with retryAfterSeconds) when over the limit. */
    async take(key: string, cost = 1) {
      const result = await consume(key, cost);
      if (!result.allowed) {
        throw new AppError("RATE_LIMITED", {
          params: { retryAfterSeconds: result.retryAfterSeconds },
        });
      }
    },
    reset: (key: string) => limiter.delete(key),
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
