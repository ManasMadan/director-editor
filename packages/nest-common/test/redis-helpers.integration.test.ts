/** Integration tests for the Redis-backed helpers. Requires `bun run db:up`. */
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { CacheService } from "../src/cache";
import { AppError } from "../src/errors";
import { IdempotencyStore } from "../src/idempotency";
import { createRateLimiter } from "../src/rate-limit";
import { redisDatabase } from "../src/testing";

const redis = new Redis(redisDatabase(12), {
  maxRetriesPerRequest: null,
});
afterAll(() => redis.quit());

describe("CacheService", () => {
  it("loads once for concurrent misses, then serves from Redis", async () => {
    const cache = new CacheService(redis, `test-${randomUUID()}`);
    let loads = 0;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    // The load finishes only when the test says, so the other nine ask while it runs.
    const load = async () => {
      loads += 1;
      await released;
      return { plan: "pro" };
    };
    const plan = z.object({ plan: z.string() });
    const asked = Promise.all(Array.from({ length: 10 }, () => cache.wrap("k", 60, plan, load)));
    // Valkey answers a connection's commands in order: once this PING is back, all ten
    // lookups have missed and are waiting on the one load.
    await redis.ping();
    release();
    const results = await asked;
    expect(results.every((r) => r.plan === "pro")).toBe(true);
    expect(await cache.wrap("k", 60, plan, load)).toEqual({ plan: "pro" });
    expect(loads).toBe(1);
    await cache.invalidate("k");
    expect(await cache.get("k", plan)).toBeUndefined();
  });

  it("treats an entry in another shape as a miss, and a Date as its schema reads it", async () => {
    const cache = new CacheService(redis, `test-${randomUUID()}`);
    await cache.set("k", { plan: 3 }, 60);
    const plan = z.object({ plan: z.string() });
    expect(await cache.get("k", plan)).toBeUndefined();
    expect(await cache.wrap("k", 60, plan, async () => ({ plan: "free" }))).toEqual({
      plan: "free",
    });
    const at = new Date("2026-09-30T12:00:00Z");
    await cache.set("when", { at }, 60);
    expect(await cache.get("when", z.object({ at: z.coerce.date() }))).toEqual({ at });
  });
});

describe("rate limiter", () => {
  it("allows the configured number of calls per window, then reports when to retry", async () => {
    const limiter = createRateLimiter(redis, {
      name: `test-${randomUUID()}`,
      points: 3,
      windowSeconds: 60,
    });
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.consume("ip-1"));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]?.retryAfterSeconds).toBeGreaterThan(0);
    expect((await limiter.consume("ip-2")).allowed).toBe(true);
  });

  it("forgets what a key used once it's reset", async () => {
    const limiter = createRateLimiter(redis, {
      name: `test-reset-${randomUUID()}`,
      points: 1,
      windowSeconds: 60,
    });
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(false);
    await limiter.reset("k");
    expect((await limiter.consume("k")).allowed).toBe(true);
  });

  it("take() throws RATE_LIMITED with when to retry, past the limit", async () => {
    const limiter = createRateLimiter(redis, {
      name: `test-take-${randomUUID()}`,
      points: 1,
      windowSeconds: 60,
    });
    await limiter.take("k");
    const error = await limiter.take("k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      params: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it("fails closed or open when Redis is unavailable, as configured", async () => {
    const dead = new Redis("redis://localhost:1", {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    const closed = createRateLimiter(dead, {
      name: "c",
      points: 5,
      windowSeconds: 60,
      onRedisError: "deny",
    });
    const open = createRateLimiter(dead, {
      name: "o",
      points: 5,
      windowSeconds: 60,
      onRedisError: "allow",
    });
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect((await closed.consume("x")).allowed).toBe(false);
    expect((await open.consume("x")).allowed).toBe(true);
    // Said, not silent, and once per limiter however many requests hit the outage.
    for (let i = 0; i < 5; i++) {
      await closed.consume("x");
    }
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ limiter: "c", failing: "closed" }),
      "rate limiter can't reach Redis",
    );
    logged.mockRestore();
    dead.disconnect();
  });
});

describe("IdempotencyStore", () => {
  it("runs once and replays the stored result for the same key", async () => {
    const store = new IdempotencyStore(redis);
    const key = randomUUID();
    let runs = 0;
    const op = async () => ({ charged: ++runs });
    const charge = z.object({ charged: z.number() });
    expect(await store.run(key, charge, op)).toEqual({ charged: 1 });
    expect(await store.run(key, charge, op)).toEqual({ charged: 1 });
    expect(runs).toBe(1);
  });

  it("rejects a concurrent duplicate and allows a retry after a failure", async () => {
    const store = new IdempotencyStore(redis);
    const key = randomUUID();
    // A slow operation on purpose, still running when the duplicate arrives.
    const slow = store.run(
      key,
      z.string(),
      () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 100)),
    );
    await expect(store.run(key, z.string(), async () => "dup")).rejects.toBeInstanceOf(AppError);
    await slow;

    const failing = randomUUID();
    await expect(
      store.run(failing, z.string(), () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await store.run(failing, z.string(), async () => "second try")).toBe("second try");
  });
});

describe("IdempotencyStore's replay", () => {
  it("refuses a stored result that no longer matches, rather than run the operation again", async () => {
    const store = new IdempotencyStore(redis);
    const key = randomUUID();
    let runs = 0;
    await store.run(key, z.object({ charged: z.number() }), async () => ({ charged: ++runs }));
    await expect(
      store.run(key, z.object({ receipt: z.string() }), async () => ({ receipt: "r" })),
    ).rejects.toThrow();
    expect(runs).toBe(1);
  });
});
