/**
 * The base every BullMQ processor extends instead of WorkerHost: a job that fails, and
 * a worker that errors, are logged with what identifies them. @nestjs/bullmq only binds
 * the events a processor declares, and BullMQ itself says nothing about a failed job, so
 * without this a job could retry and land in the failed set with nothing in the logs.
 *
 * Every run also writes a `job.finished` activity line (activity.ts), ok or failed, with
 * the user and workspace it ran for and the request that queued it (the job's `meta`),
 * so a person's background work shows in their timeline next to what they asked for.
 */
import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { fieldOf } from "@repo/contracts/objects";
import type { Job } from "bullmq";
import { type Activity, type ActivityLogger, logActivity, outcomeOf } from "./activity";

type AnyJob = Job<unknown, unknown>;

/** A text field of a value whose shape isn't known (a job's data), if it is text. */
function textOf(value: unknown, key: string): string | undefined {
  const field = fieldOf(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * A job's activity line. The meta is the producer's, never trusted for more than naming
 * whom the job ran for: every field is read as optional text. An event job names its event.
 */
export function jobActivity(
  job: Pick<
    AnyJob,
    "data" | "queueName" | "name" | "id" | "attemptsMade" | "processedOn" | "finishedOn"
  >,
  { outcome, reason }: Pick<Activity, "outcome" | "reason">,
): Activity {
  const meta = fieldOf(job.data, "meta");
  const event = textOf(fieldOf(job.data, "payload"), "name");
  return {
    activity: "job.finished",
    outcome,
    reason,
    actor: { userId: textOf(meta, "userId") },
    orgId: textOf(meta, "orgId"),
    requestId: textOf(meta, "requestId"),
    target: {
      queue: job.queueName,
      job: job.name,
      jobId: job.id ?? null,
      attempt: job.attemptsMade,
      ...(event && { event }),
    },
    durationMs:
      job.finishedOn && job.processedOn ? Math.max(0, job.finishedOn - job.processedOn) : undefined,
  };
}

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
  // Nest's logger, as activity lines are written: through pino, like every other line.
  readonly #activity: ActivityLogger = {
    info: (line, message) => this.#log.log(line, message),
    warn: (line, message) => this.#log.warn(line, message),
  };

  @OnWorkerEvent("completed")
  onJobCompleted(job: AnyJob) {
    logActivity(this.#activity, jobActivity(job, { outcome: "ok" }));
  }

  @OnWorkerEvent("failed")
  onJobFailed(job: AnyJob | undefined, error: Error) {
    const attempts = job?.opts.attempts ?? 1;
    const final = !job || job.attemptsMade >= attempts || error.name === "UnrecoverableError";
    if (job) {
      // An error code when the job threw one, else the error's kind; its details are on
      // the error line below.
      const { reason } = outcomeOf(error);
      const failed = jobActivity(job, {
        outcome: "failed",
        reason: reason === "INTERNAL" ? error.name : reason,
      });
      logActivity(this.#activity, { ...failed, target: { ...failed.target, final } });
    }
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
