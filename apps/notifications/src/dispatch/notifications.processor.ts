import { Processor } from "@nestjs/bullmq";
import { idOf, type NotificationQueue, parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import { JobProcessor, runJob } from "@repo/nest-common";
import { DigestService } from "../digest/digest.service";
import { env } from "../env";
import { Dispatcher } from "./dispatcher";

/**
 * Consumers for both notification queues. They share the dispatcher but run in separate
 * worker pools with their own concurrency, so bulk sends never delay critical ones.
 * Failures throw: BullMQ retries with the queue's backoff and finally keeps the job in
 * the failed set for inspection and replay.
 */
async function handle(queue: NotificationQueue, job: UncheckedJob, dispatcher: Dispatcher) {
  // Producers choose the id (createProducer requires one).
  const jobId = idOf(job);
  if (job.name === "deferred") {
    const { meta, payload } = parseJob(queue, "deferred", job.data);
    await runJob(meta, `job:${jobId}`, () =>
      dispatcher.deliverDeferred(payload.payload, payload.channel, payload.userId, payload.key),
    );
    return;
  }
  if (job.name !== "send") {
    throw new Error(`Unknown job "${job.name}" on ${queue}`);
  }
  const { meta, payload } = parseJob(queue, "send", job.data);
  // Restore the producer's request context so these logs carry its request id.
  await runJob(meta, `job:${jobId}`, () =>
    // The producer-chosen job id is stable across retries and Redis restarts.
    dispatcher.dispatch(payload, jobId),
  );
}

@Processor("notifications-critical", {
  concurrency: env.NOTIFICATIONS_CRITICAL_CONCURRENCY,
  prefix: queuePrefix("notifications-critical"),
})
export class CriticalNotificationsProcessor extends JobProcessor {
  constructor(private readonly dispatcher: Dispatcher) {
    super();
  }
  process(job: UncheckedJob) {
    return handle("notifications-critical", job, this.dispatcher);
  }
}

@Processor("notifications-bulk", {
  concurrency: env.NOTIFICATIONS_BULK_CONCURRENCY,
  prefix: queuePrefix("notifications-bulk"),
})
export class BulkNotificationsProcessor extends JobProcessor {
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly digests: DigestService,
  ) {
    super();
  }
  async process(job: UncheckedJob) {
    if (job.name === "digests") {
      parseJob("notifications-bulk", "digests", job.data);
      await this.digests.scheduleDue();
      return;
    }
    if (job.name === "digest") {
      const { meta, payload } = parseJob("notifications-bulk", "digest", job.data);
      await runJob(meta, `job:${job.id}`, () => this.digests.send(payload.userId, payload.date));
      return;
    }
    return handle("notifications-bulk", job, this.dispatcher);
  }
}
