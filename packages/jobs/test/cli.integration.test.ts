/**
 * `bun run jobs` (scripts/jobs.ts, src/cli.ts) against a real Valkey: jobs' database 19, on one of
 * the real queues (the command opens them by name), with job ids of this run's own.
 */
import { randomUUID } from "node:crypto";
import { eventually } from "@repo/testing/eventually";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs } from "../src/cli";
import { queuePrefix, queues } from "../src/queues";

// A database of its own (docs/testing.md): its worker fails every job on a real queue,
// and would take and lock any job another suite added to that queue in the same one.
const url = new URL(process.env.REDIS_URL ?? "redis://localhost:56379");
url.pathname = "/20";
const REDIS = url.toString();
const NAME = Object.keys(queues)[0] as keyof typeof queues;
const connection = new Redis(REDIS, { maxRetriesPerRequest: null });
const queue = new Queue(NAME, { connection, prefix: queuePrefix(NAME) });
const id = `cli-${randomUUID()}`;
let worker: Worker;

const until = (check: () => Promise<boolean>) => eventually(check, (ok) => ok, { timeout: 10_000 });
const failed = (job = id) => until(async () => (await queue.getJob(job))?.isFailed() ?? false);

/** Runs the command; what it printed and its exit code. */
async function run(...argv: string[]) {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const code = await jobs(argv, REDIS);
  const printed = write.mock.calls
    .map(([text]) => String(text))
    .join("")
    .trimEnd();
  write.mockRestore();
  return { code, printed };
}

beforeAll(async () => {
  worker = new Worker(
    NAME,
    async () => {
      throw new Error("provider down");
    },
    { connection, prefix: queuePrefix(NAME) },
  );
  await queue.add("send", {}, { jobId: id, attempts: 1 });
  expect(await failed()).toBe(true);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await worker?.close();
  await (await queue.getJob(id))?.remove();
  await queue.close();
  await connection.quit();
});

describe("bun run jobs", () => {
  it("shows every queue's counts, marking the ones with failed jobs", async () => {
    const { code, printed } = await run();
    expect(code).toBe(0);
    const lines = printed.split("\n");
    expect(lines).toHaveLength(Object.keys(queues).length);
    expect(lines.find((line) => line.startsWith(`${NAME} `))).toMatch(
      /failed [1-9]\d* {2}← failed jobs$/,
    );
    expect(lines.some((line) => line.endsWith("failed 0"))).toBe(true);
  });

  it("lists the failed jobs and why", async () => {
    const { printed } = await run("failed", NAME);
    expect(printed).toMatch(
      new RegExp(`${id}  send  \\d{4}-.+Z  after 1 attempts\\n  provider down`),
    );
    expect((await run("failed", NAME, "1")).printed.split("\n")).toHaveLength(2);
  });

  it("shows ? for a failed job without a finish time (another client wrote it)", async () => {
    const other = `cli-${randomUUID()}`;
    await queue.add("send", {}, { jobId: other, attempts: 1 });
    expect(await failed(other)).toBe(true);
    await connection.hdel(queue.toKey(other), "finishedOn");
    expect((await run("failed", NAME)).printed).toContain(`${other}  send  ?  after 1 attempts`);
    await (await queue.getJob(other))?.remove();
  });

  it("retries a chosen job, then every failed one", async () => {
    expect((await run("retry", NAME, id)).printed).toBe("Retried 1 jobs.");
    expect(await failed()).toBe(true);
    expect((await run("retry", NAME)).printed).toMatch(/^Retried [1-9]\d* jobs\.$/);
    expect(await failed()).toBe(true);
  });

  it("discards a job that must never run", async () => {
    expect((await run("discard", NAME, id, "missing")).printed).toBe("Discarded 1 jobs.");
    expect(await queue.getJob(id)).toBeUndefined();
    expect((await run("failed", NAME)).printed).toBe("No failed jobs.");
  });

  it("refuses what it can't do", async () => {
    expect(await run("discard", NAME)).toMatchObject({
      code: 1,
      printed: expect.stringContaining("Name the job ids"),
    });
    expect(await run("failed")).toMatchObject({
      code: 1,
      printed: expect.stringContaining("Name a queue: "),
    });
    expect(await run("retry", "nope")).toMatchObject({ code: 1 });
    expect(await run("restart")).toMatchObject({
      code: 1,
      printed: expect.stringContaining('Unknown command "restart"'),
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await jobs([], "")).toBe(1);
    expect(String(write.mock.calls[0]?.[0])).toContain("REDIS_URL isn't set");
  });
});
