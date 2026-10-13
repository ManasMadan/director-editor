/**
 * The base every BullMQ processor extends instead of WorkerHost: a job that fails, and
 * a worker that errors, are logged with what identifies them. @nestjs/bullmq only binds
 * the events a processor declares, and BullMQ itself says nothing about a failed job, so
 * without this a job could retry and land in the failed set with nothing in the logs.
 */
import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";

/** Anything thrown, as an Error (a thrown string or object becomes one's message). */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** An error and its causes, as plain fields (undici puts the real reason in `cause`). */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause !== undefined && depth < 3 && { cause: describeError(error.cause, depth + 1) }),
  };
}

export abstract class JobProcessor extends WorkerHost {
  // A private field of its own: subclasses often have a `log` of theirs.
  readonly #log = new Logger(this.constructor.name);

  @OnWorkerEvent("failed")
  onJobFailed(job: Job<unknown, unknown> | undefined, error: Error) {
    const attempts = job?.opts.attempts ?? 1;
    const final = !job || job.attemptsMade >= attempts || error.name === "UnrecoverableError";
    this.#log.error(
      {
        queue: job?.queueName,
        jobId: job?.id,
        jobName: job?.name,
        attempt: job?.attemptsMade,
        attempts,
        final,
        err: describeError(error),
      },
      final ? "job failed for good" : "job failed; it will be retried",
    );
  }

  @OnWorkerEvent("error")
  onWorkerError(error: Error) {
    this.#log.error({ err: describeError(error) }, "queue worker error");
  }
}
