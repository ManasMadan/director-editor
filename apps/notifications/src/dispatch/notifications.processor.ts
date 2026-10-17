import { Processor } from "@nestjs/bullmq";
import { idOf, parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import { JobProcessor, runJob } from "@repo/nest-common";
import { env } from "../env";
import { Dispatcher } from "./dispatcher";

/**
 * The consumer of the notification queue. Failures throw: BullMQ retries with the
 * queue's backoff and finally keeps the job in the failed set for inspection and replay.
 */
@Processor("notifications-critical", {
  concurrency: env.NOTIFICATIONS_CRITICAL_CONCURRENCY,
  prefix: queuePrefix("notifications-critical"),
})
export class CriticalNotificationsProcessor extends JobProcessor {
  constructor(private readonly dispatcher: Dispatcher) {
    super();
  }

  async process(job: UncheckedJob) {
    if (job.name !== "send") {
      throw new Error(`Unknown job "${job.name}" on notifications-critical`);
    }
    // Producers choose the id (createProducer requires one).
    const jobId = idOf(job);
    const { meta, payload } = parseJob("notifications-critical", "send", job.data);
    // Restore the producer's request context so these logs carry its request id.
    await runJob(meta, `job:${jobId}`, () =>
      // The producer-chosen job id is stable across retries and Redis restarts.
      this.dispatcher.dispatch(payload, jobId),
    );
  }
}
