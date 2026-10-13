/**
 * Failed jobs: what went wrong, and putting them back once the cause is fixed. BullMQ
 * keeps a queue's failed jobs (`removeOnFail` in queues.ts: 30 days for most queues),
 * so that set is the dead-letter queue; `bun run jobs` (scripts/jobs.ts) drives these
 * against any environment's Valkey.
 *
 * A retried job starts over with its full retry schedule. Consumers are idempotent on
 * the job id, so retrying something that half-succeeded is safe.
 */
import { idOf, type UncheckedQueue } from "./producer";

export interface FailedJob {
  id: string;
  name: string;
  attemptsMade: number;
  failedReason: string;
  failedAt: Date | null;
  data: unknown;
}

/** The most recently failed jobs first. */
export async function failedJobs(queue: UncheckedQueue, limit = 50): Promise<FailedJob[]> {
  const jobs = await queue.getFailed(0, limit - 1);
  return jobs.map((job) => ({
    id: idOf(job),
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    data: job.data,
  }));
}

/**
 * Moves failed jobs back to waiting: the given ids, or every failed job. Returns how
 * many moved; an id that isn't failed (already retried, or removed) is skipped.
 *
 * One job at a time rather than `queue.retryJobs()`: that moves them back without
 * resetting their attempts, so a job would come back with its retries already spent.
 */
export async function retryFailed(queue: UncheckedQueue, ids?: readonly string[]): Promise<number> {
  const targets = ids ?? (await allFailedIds(queue));
  let moved = 0;
  for (const id of targets) {
    const job = await queue.getJob(id);
    if (!job || !(await job.isFailed())) {
      continue;
    }
    await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
    moved += 1;
  }
  return moved;
}

/** Deletes failed jobs that should never run (a payload a code change made obsolete). */
export async function discardFailed(
  queue: UncheckedQueue,
  ids: readonly string[],
): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    const job = await queue.getJob(id);
    if (!job || !(await job.isFailed())) {
      continue;
    }
    await job.remove();
    removed += 1;
  }
  return removed;
}

async function allFailedIds(queue: UncheckedQueue) {
  const ids: string[] = [];
  const page = 500;
  for (let start = 0; ; start += page) {
    const jobs = await queue.getFailed(start, start + page - 1);
    ids.push(...jobs.map(idOf));
    if (jobs.length < page) {
      return ids;
    }
  }
}
