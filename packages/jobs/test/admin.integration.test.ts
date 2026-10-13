/** Failed jobs, listed and put back, on a real Valkey. */
import { randomUUID } from "node:crypto";
import { eventually } from "@repo/testing/eventually";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discardFailed, failedJobs, retryFailed } from "../src/admin";

// The jobs package's own Valkey database (docs/testing.md), under a prefix of this
// run's own, so nothing else's keys are touched.
const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
url.pathname = "/19";
const connection = new Redis(url.toString(), { maxRetriesPerRequest: null });
const prefix = `test-admin-${randomUUID()}`;
const queue = new Queue("jobs-admin", { connection, prefix });
/** Fails a job until it's told to succeed. */
let succeed = false;
const handled: string[] = [];
let worker: Worker;

const until = (check: () => Promise<boolean>) => eventually(check, (ok) => ok, { timeout: 10_000 });

beforeAll(async () => {
  worker = new Worker(
    "jobs-admin",
    async (job) => {
      if (!succeed) {
        throw new Error(`provider down (${job.data.n})`);
      }
      handled.push(job.id ?? "");
    },
    { connection, prefix },
  );
  for (const n of [1, 2, 3]) {
    await queue.add("send", { n }, { jobId: `job-${n}`, attempts: 2 });
  }
  expect(await until(async () => (await queue.getFailedCount()) === 3)).toBe(true);
});

afterAll(async () => {
  await worker?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe("failed jobs", () => {
  it("lists what failed and why, after every attempt was used", async () => {
    const failed = await failedJobs(queue);
    expect(failed.map((job) => job.id).sort()).toEqual(["job-1", "job-2", "job-3"]);
    expect(failed[0]).toMatchObject({
      name: "send",
      attemptsMade: 2,
      failedReason: expect.stringMatching(/provider down/),
      failedAt: expect.any(Date),
    });
    expect(await failedJobs(queue, 1)).toHaveLength(1);
  });

  it("lists a failed job whose finish time is missing, without inventing one", async () => {
    await queue.add("send", { n: 4 }, { jobId: "job-4" });
    expect(await until(async () => (await queue.getJob("job-4"))?.isFailed() ?? false)).toBe(true);
    // As a job written by another BullMQ version, or edited by hand, may be.
    await connection.hdel(`${prefix}:jobs-admin:job-4`, "finishedOn");
    const listed = (await failedJobs(queue)).find((failed) => failed.id === "job-4");
    expect(listed).toMatchObject({
      failedAt: null,
      failedReason: expect.stringMatching(/provider down/),
    });
    expect(await discardFailed(queue, ["job-4"])).toBe(1);
  });

  it("discards one that should never run, and retries a chosen one with a fresh budget", async () => {
    expect(await discardFailed(queue, ["job-3", "missing"])).toBe(1);
    succeed = true;
    expect(await retryFailed(queue, ["job-1", "missing"])).toBe(1);
    expect(await until(async () => handled.includes("job-1"))).toBe(true);
    // A job that isn't failed any more is skipped.
    expect(await retryFailed(queue, ["job-1"])).toBe(0);
  });

  it("retries every failed job", async () => {
    expect(await retryFailed(queue)).toBe(1);
    expect(await until(async () => handled.includes("job-2"))).toBe(true);
    expect(await queue.getFailedCount()).toBe(0);
    expect(await queue.getJob("job-3")).toBeUndefined();
  });
});

describe("a long failed set", () => {
  it("retries every failed job, however many pages of them there are", async () => {
    const many = new Queue("jobs-admin-many", { connection, prefix });
    let failing = true;
    const done = new Set<string>();
    const busy = new Worker(
      "jobs-admin-many",
      async (job) => {
        if (failing) {
          throw new Error("provider down");
        }
        done.add(job.id as string);
      },
      { connection, prefix, concurrency: 100 },
    );
    // One more than the page retryFailed reads the failed set in.
    await many.addBulk(Array.from({ length: 501 }, (_, n) => ({ name: "send", data: { n } })));
    expect(await until(async () => (await many.getFailedCount()) === 501)).toBe(true);
    failing = false;
    expect(await retryFailed(many)).toBe(501);
    expect(await until(async () => done.size === 501)).toBe(true);
    await busy.close();
    await many.obliterate({ force: true });
    await many.close();
  });
});
