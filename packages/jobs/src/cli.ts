/**
 * `bun run jobs` (scripts/jobs.ts): the queues at a glance, and their failed jobs listed,
 * retried or discarded, against any environment's Valkey. Here rather than in the script
 * so its tests run against a real Valkey with the package's integration tests.
 */
import { hasKey, keysOf } from "@repo/contracts/objects";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { discardFailed, failedJobs, retryFailed } from "./admin";
import type { UncheckedQueue } from "./producer";
import { type QueueName, queuePrefix, queues } from "./queues";

/** One line of output (a CLI, not a service: nothing here goes through the logger). */
const print = (line: string) => process.stdout.write(`${line}\n`);
const fail = (message: string) => print(`  \x1b[31m✖\x1b[0m ${message}`);

/** Every queue's counts, one line each. */
async function status(open: (queue: QueueName) => UncheckedQueue, names: QueueName[]) {
  for (const queueName of names) {
    const queue = open(queueName);
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    const marker = counts.failed ? "  ← failed jobs" : "";
    print(
      `${queueName.padEnd(24)} waiting ${counts.waiting}  active ${counts.active}  delayed ${counts.delayed}  failed ${counts.failed}${marker}`,
    );
    await queue.close();
  }
  return 0;
}

/** `failed`, `retry` or `discard` on one queue's failed jobs; the exit code. */
async function onFailed(command: string, queue: UncheckedQueue, rest: string[]) {
  if (command === "failed") {
    const failed = await failedJobs(queue, Number(rest[0] ?? 20));
    if (failed.length === 0) {
      print("No failed jobs.");
    }
    for (const job of failed) {
      print(
        `${job.id}  ${job.name}  ${job.failedAt?.toISOString() ?? "?"}  after ${job.attemptsMade} attempts\n  ${job.failedReason}`,
      );
    }
  } else if (command === "retry") {
    print(`Retried ${await retryFailed(queue, rest.length ? rest : undefined)} jobs.`);
  } else if (rest.length === 0) {
    fail("Name the job ids to discard (see `bun run jobs failed <queue>`).");
    return 1;
  } else {
    print(`Discarded ${await discardFailed(queue, rest)} jobs.`);
  }
  return 0;
}

/** Runs the command `argv` names against the Valkey at `url`; the exit code. */
export async function jobs(
  argv = process.argv.slice(2),
  url = process.env.REDIS_URL,
): Promise<number> {
  const [command = "status", name, ...rest] = argv;
  if (!url) {
    fail("REDIS_URL isn't set (bun run setup writes it to .env)");
    return 1;
  }
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  const names = keysOf(queues);
  const open = (queue: QueueName): UncheckedQueue =>
    new Queue(queue, { connection, prefix: queuePrefix(queue) });

  try {
    if (command === "status") {
      return await status(open, names);
    }
    if (!["failed", "retry", "discard"].includes(command)) {
      fail(`Unknown command "${command}": status, failed, retry or discard.`);
      return 1;
    }
    if (!name || !hasKey(queues, name)) {
      fail(`Name a queue: ${names.join(", ")}`);
      return 1;
    }
    const queue = open(name);
    try {
      return await onFailed(command, queue, rest);
    } finally {
      await queue.close();
    }
  } finally {
    await connection.quit();
  }
}
