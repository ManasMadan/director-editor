/**
 * Typed BullMQ producer.
 *
 *   const notifications = createProducer("notifications-critical", redis);
 *   await notifications.add("send", payload, { jobId: uuidv7() });
 *
 * The job name and payload are checked against `queues` at compile time and the
 * payload is validated at runtime before it is written to Redis.
 *
 * `jobId` is required and chosen by the producer (a UUIDv7, or the outbox event id):
 * BullMQ ignores a second add with the same id, so a retried request never enqueues
 * twice, and consumers use it as the idempotency key towards providers. BullMQ's own
 * auto-increment ids restart after a Redis flush and must never be used for that.
 */
import {
  type ConnectionOptions,
  type Job,
  type JobsOptions,
  Queue,
  UnrecoverableError,
} from "bullmq";
import * as z from "zod";
import {
  type JobMeta,
  type JobName,
  type JobPayload,
  jobMeta,
  type QueueName,
  queuePrefix,
  queues,
} from "./queues";

/**
 * A job as BullMQ hands it back, to a worker or from a queue's lists. Its data stays
 * `unknown` until `parseJob` checks it, and its name is any string until `jobName` does:
 * during a rolling deploy, a newer version may have written it.
 */
export type UncheckedJob = Job<unknown, unknown>;
/** A queue whose jobs are read back unchecked (see `UncheckedJob`). */
export type UncheckedQueue = Queue<unknown, unknown>;

/** What one of a queue's jobs is stored as (`createProducer` writes it). */
type JobData<Q extends QueueName, J extends JobName<Q> = JobName<Q>> = {
  meta: JobMeta;
  payload: JobPayload<Q, J>;
};
/**
 * A queue for adding jobs to directly, where a producer can't (a job scheduler's
 * template): names and data are checked against the contract at compile time.
 */
export type QueueOf<Q extends QueueName> = Queue<JobData<Q>, unknown, JobName<Q>>;

/** Whether a queue has a job by this name. */
export function isJobName<Q extends QueueName>(queue: Q, name: string): name is JobName<Q> {
  return Object.hasOwn(queues[queue].jobs, name);
}

/** A job's name, checked against its queue's contract. */
export function jobName<Q extends QueueName>(queue: Q, name: string): JobName<Q> {
  if (!isJobName(queue, name)) {
    throw new Error(`Unknown job "${name}" on queue "${queue}"`);
  }
  return name;
}

/** A job's id. Every job BullMQ hands back has one (it's in the job's Redis key). */
export function idOf(job: Pick<Job, "id" | "name">): string {
  if (job.id === undefined) {
    throw new Error(`Job "${job.name}" has no id`);
  }
  return job.id;
}

/**
 * Every job's schema, typed per queue and job. TypeScript can't relate a lookup on generic
 * keys in `queues` back to the payload type (a known limit with correlated unions), but
 * it can through a mapped type like this one, and `queues` checks against it.
 */
const schemas: { [Q in QueueName]: { jobs: { [J in JobName<Q>]: z.ZodType<JobPayload<Q, J>> } } } =
  queues;

/** The payload schema for one job. */
function schemaFor<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
): z.ZodType<JobPayload<Q, J>> {
  jobName(queue, job);
  return schemas[queue].jobs[job];
}

/** BullMQ builds Redis keys from job ids with ":" as separator, so ids can't contain one. */
function checkJobId(jobId: string) {
  if (!jobId || jobId.includes(":")) {
    throw new Error(`Invalid job id "${jobId}": use a non-empty id without ":" (e.g. a UUID)`);
  }
  return jobId;
}

export function createProducer<Q extends QueueName>(queue: Q, connection: ConnectionOptions) {
  const bull: UncheckedQueue = new Queue(queue, {
    connection,
    prefix: queuePrefix(queue),
    defaultJobOptions: queues[queue].options,
  });
  return {
    queue: bull,
    async add<J extends JobName<Q>>(
      job: J,
      payload: JobPayload<Q, J>,
      { meta = {}, ...options }: Omit<JobsOptions, "jobId"> & { jobId: string; meta?: JobMeta },
    ) {
      checkJobId(options.jobId);
      return bull.add(
        job,
        { meta: jobMeta.parse(meta), payload: schemaFor(queue, job).parse(payload) },
        options,
      );
    },
    /** Many jobs in one round trip (same validation and required ids as `add`). */
    async addBulk<J extends JobName<Q>>(
      jobs: {
        name: J;
        payload: JobPayload<Q, J>;
        options: Omit<JobsOptions, "jobId"> & { jobId: string; meta?: JobMeta };
      }[],
    ) {
      return bull.addBulk(
        jobs.map(({ name, payload, options: { meta = {}, ...options } }) => ({
          name,
          data: { meta: jobMeta.parse(meta), payload: schemaFor(queue, name).parse(payload) },
          opts: { ...options, jobId: checkJobId(options.jobId) },
        })),
      );
    },
    close: () => bull.close(),
  };
}

export type Producer<Q extends QueueName> = ReturnType<typeof createProducer<Q>>;

/**
 * Validates a consumed job against its contract and returns its metadata and payload.
 * Throws (so the job fails and is kept for inspection) on any mismatch.
 */
export function parseJob<Q extends QueueName, J extends JobName<Q>>(
  queue: Q,
  job: J,
  data: unknown,
): { meta: JobMeta; payload: JobPayload<Q, J> } {
  const parsed = z.object({ meta: jobMeta, payload: schemaFor(queue, job) }).safeParse(data);
  // A payload that doesn't match its schema never will: retrying it only reaches the
  // failed set later, with full backoff, so the job fails for good at once.
  if (!parsed.success) {
    throw new UnrecoverableError(`invalid ${queue}/${job} job: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
