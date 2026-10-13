/**
 * Cache-aside on Redis.
 *
 *   const plan = await cache.wrap(`org:${orgId}:plan`, 300, planSchema, () => billing.loadPlan(orgId));
 *   await cache.invalidate(`org:${orgId}:plan`);   // e.g. from a billing.plan_changed event
 *
 * - Concurrent misses in one process share one load (no stampede on a cold key).
 * - TTLs get ±10% jitter so keys written together don't all expire together.
 * - What comes back is parsed with the caller's schema: an entry written by an older
 *   release in another shape is a miss, loaded again, never a value of the wrong type.
 *   Keys are versioned too (`CACHE_VERSION`), to drop every entry at once.
 * - Values are JSON; cache only what serializes losslessly (no Maps or classes; a Date
 *   comes back as its string, so its schema must coerce it).
 *
 * Tenant data must include the org id in the key; a cache is not protected by
 * row-level security.
 */
import type { Redis } from "ioredis";
import type * as z from "zod";

const CACHE_VERSION = "v1";

export class CacheService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
  ) {}

  private key(key: string) {
    return `cache:${this.namespace}:${CACHE_VERSION}:${key}`;
  }

  async get<T>(key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null) {
      return undefined;
    }
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  async set(key: string, value: unknown, ttlSeconds: number) {
    const jittered = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)));
    await this.redis.set(this.key(key), JSON.stringify(value), "EX", jittered);
  }

  async wrap<T>(
    key: string,
    ttlSeconds: number,
    schema: z.ZodType<T>,
    load: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get(key, schema);
    if (cached !== undefined) {
      return cached;
    }

    // Another call is loading this key: the same value it will cache, so the same parse.
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return schema.parse(await pending);
    }

    const loading = load()
      .then(async (value) => {
        await this.set(key, value, ttlSeconds);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, loading);
    return loading;
  }

  async invalidate(key: string) {
    await this.redis.del(this.key(key));
  }
}
