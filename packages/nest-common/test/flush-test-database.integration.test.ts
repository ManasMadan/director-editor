/**
 * The guard on the suites' Valkey flush. It connects to database 0 on purpose, the dev
 * stack's, and must leave it untouched.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { flushTestDatabase } from "../src/testing";

describe("flushTestDatabase", () => {
  it("refuses to flush database 0, where ioredis lands when a suite's number doesn't exist", async () => {
    // REDIS_URL as the dev stack uses it, with no database number: database 0.
    const dev = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    const key = `test-${randomUUID()}`;
    try {
      await dev.set(key, "kept", "EX", 60);
      await expect(flushTestDatabase(dev)).rejects.toThrow("Refusing to flush Valkey database 0");
      expect(await dev.get(key)).toBe("kept");
    } finally {
      await dev.del(key);
      await dev.quit();
    }
  });
});
