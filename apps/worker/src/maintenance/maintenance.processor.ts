/**
 * Scheduled housekeeping. Every task runs a database function that owns the details
 * (see the audit_log_and_retention migration): the worker's role can't delete from other
 * services' tables or create partitions, only call these narrowly granted functions.
 *
 * Schedules are BullMQ job schedulers (upserted at boot, so changing a pattern here and
 * deploying is all it takes). BullMQ runs each occurrence once, whatever the replica
 * count, so there's no separate cron or leader election.
 */
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, type OnApplicationBootstrap } from "@nestjs/common";
import { authSessionKeys, DEMO_GUEST_LIFETIME_S } from "@repo/contracts/auth-settings";
import { orgIdSchema, recordingAttemptIdSchema } from "@repo/contracts/ids";
import { entriesOf } from "@repo/contracts/objects";
import {
  type JobName,
  jobName,
  type Producer,
  parseJob,
  type QueueOf,
  queuePrefix,
  type UncheckedJob,
} from "@repo/jobs";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  InjectRedis,
  JobProcessor,
  PinoLogger,
  type Redis,
  row,
  rows,
  runJob,
} from "@repo/nest-common";
import * as z from "zod";
import { env } from "../env";
import { FilesCleanup } from "../files/files.cleanup";
import { OUTBOX_SOURCES } from "../outbox/sources";

// What the retention functions return: how many they made, dropped or deleted.
const int = z.object({ n: z.number().int() });
const count = z.object({ n: z.bigint() });
// A demo guest auth.purge_expired_guests deleted, and its sessions' tokens.
const expiredGuest = z.object({ guest_id: z.uuid(), session_tokens: z.array(z.string()) });
// What finishing the recording sessions left open answers: the attempts to cut.
const idleAttempt = z.object({ org_id: orgIdSchema, attempt_id: recordingAttemptIdSchema });
/**
 * A recording session nothing has reached for this long was left open (the tab closed and
 * never came back): it's finished for its member, and its attempts are cut.
 */
const RECORDING_IDLE_HOURS = 6;

/** Where the attempts of the sessions it finishes go, with the queue's own options. */
export const RECORDING_QUEUE = Symbol("RECORDING_QUEUE");

type Task = JobName<"maintenance">;

/** When each task runs (cron, UTC). */
const SCHEDULES: Record<Task, string> = {
  "audit-partitions": "0 2 * * *",
  "outbox-retention": "15 3 * * *",
  "session-retention": "0 * * * *",
  "files-cleanup": "30 * * * *",
  "demo-retention": "20 * * * *",
  "recording-retention": "45 * * * *",
};

// Demo guests deleted a call (auth.purge_expired_guests); the task calls again while a
// call fills its batch, so a backlog clears in one run without one long transaction.
const GUEST_BATCH = 100;

// Partitions exist this far around "now", so late and early timestamps always land.
const PARTITIONS_BACK = 1;
const PARTITIONS_AHEAD = 3;

@Processor("maintenance", { concurrency: 1, prefix: queuePrefix("maintenance") })
export class MaintenanceProcessor extends JobProcessor implements OnApplicationBootstrap {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectQueue("maintenance") private readonly queue: QueueOf<"maintenance">,
    @Inject(RECORDING_QUEUE) private readonly recording: Producer<"recording">,
    private readonly files: FilesCleanup,
    @InjectRedis() private readonly redis: Redis,
    @InjectPinoLogger(MaintenanceProcessor.name) private readonly log: PinoLogger,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    // Before any audit event arrives, make sure its month has a partition.
    await this.run("audit-partitions");
    for (const [task, pattern] of entriesOf(SCHEDULES)) {
      await this.queue.upsertJobScheduler(
        task,
        { pattern, tz: "UTC" },
        { name: task, data: { meta: {}, payload: {} } },
      );
    }
  }

  async process(job: UncheckedJob) {
    const task = jobName("maintenance", job.name);
    const { meta } = parseJob("maintenance", task, job.data);
    await runJob(meta, `job:${job.id}`, () => this.run(task));
  }

  /** Runs one task now; also used by tests and the ops scripts. */
  async run(task: Task) {
    const db = this.database.write;
    const result: Record<string, number> = {};
    switch (task) {
      case "audit-partitions": {
        const cutoff = new Date();
        cutoff.setUTCMonth(cutoff.getUTCMonth() - env.AUDIT_RETENTION_MONTHS);
        const created = await row(
          int,
          db.$queryRaw`
            SELECT audit.ensure_partitions(${PARTITIONS_BACK}::int, ${PARTITIONS_AHEAD}::int) AS n`,
        );
        const dropped = await row(
          int,
          db.$queryRaw`SELECT audit.drop_partitions_before(${cutoff}::timestamptz) AS n`,
        );
        result.created = created.n;
        result.dropped = dropped.n;
        break;
      }
      case "outbox-retention":
        for (const source of OUTBOX_SOURCES) {
          const outbox = await row(
            count,
            db.$queryRawUnsafe(
              `SELECT "${source}".purge_published_outbox(make_interval(days => $1::int)) AS n`,
              env.OUTBOX_RETENTION_DAYS,
            ),
          );
          const processed = await row(
            count,
            db.$queryRawUnsafe(
              `SELECT "${source}".purge_processed_events(make_interval(days => $1::int)) AS n`,
              env.PROCESSED_EVENT_RETENTION_DAYS,
            ),
          );
          result[`${source}.outbox`] = Number(outbox.n);
          result[`${source}.processed`] = Number(processed.n);
        }
        {
          const history = await row(
            count,
            db.$queryRaw`
              SELECT webhooks.purge_history(make_interval(days => ${env.WEBHOOK_HISTORY_DAYS}::int)) AS n`,
          );
          result["webhooks.history"] = Number(history.n);
          const notifications = await row(
            count,
            db.$queryRaw`
              SELECT notifications.purge_history(make_interval(days => ${env.NOTIFICATION_HISTORY_DAYS}::int)) AS n`,
          );
          result["notifications.history"] = Number(notifications.n);
        }
        break;
      case "files-cleanup":
        Object.assign(result, await this.files.run());
        break;
      case "demo-retention":
        Object.assign(result, await this.demoRetention());
        break;
      case "recording-retention":
        Object.assign(result, await this.recordingRetention());
        break;
      case "session-retention": {
        const purged = await row(count, db.$queryRaw`SELECT auth.purge_expired() AS n`);
        result.expired = Number(purged.n);
        break;
      }
    }
    this.log.info({ task, ...result }, "maintenance task finished");
    return result;
  }

  /**
   * The demo's footage lasts a day (apps/api/src/auth/guest.ts):
   *
   * - the demo guests whose day is over are deleted, each with its workspace, takes and
   *   videos, and their sessions leave Valkey too (better-auth reads sessions there first,
   *   so the database's rows going isn't enough);
   * - the shared demo account's takes and videos older than a day are deleted.
   *
   * The deleted files' objects are queued as their rows go, so the files cleanup runs
   * straight after, and the footage leaves storage now rather than at its next turn.
   */
  private async demoRetention() {
    let guests = 0;
    for (;;) {
      const purged = await rows(
        expiredGuest,
        this.database.write
          .$queryRaw`SELECT guest_id, session_tokens FROM auth.purge_expired_guests(${GUEST_BATCH}::int)`,
      );
      const keys = purged.flatMap((guest) => authSessionKeys(guest.guest_id, guest.session_tokens));
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      guests += purged.length;
      if (purged.length < GUEST_BATCH) {
        break;
      }
    }
    const footage = await row(
      count,
      this.database.write.$queryRaw`
        SELECT files.purge_demo_footage(make_interval(secs => ${DEMO_GUEST_LIFETIME_S}::int)) AS n`,
    );
    return { guests, sharedFootage: Number(footage.n), ...(await this.files.run()) };
  }

  /**
   * Raw footage past its keeping deleted (its objects queued for the files cleanup), and
   * the sessions left open finished, their attempts sent to the clipper.
   */
  private async recordingRetention() {
    const db = this.database.write;
    const expired = await row(count, db.$queryRaw`SELECT app.purge_expired_recordings() AS n`);
    const idle = await rows(
      idleAttempt,
      db.$queryRaw`
        SELECT org_id, attempt_id
          FROM app.finish_idle_recordings(make_interval(hours => ${RECORDING_IDLE_HOURS}::int))`,
    );
    // The producer gives each job the queue's retries, backoff and clean-up (packages/jobs),
    // as apps/api's do; the attempt's id keeps it to one job however often it's queued.
    await this.recording.addBulk(
      idle.map(({ org_id: orgId, attempt_id: attemptId }) => ({
        name: "clip" as const,
        payload: { attemptId, orgId },
        options: { jobId: attemptId, meta: { orgId } },
      })),
    );
    return { expired: Number(expired.n), finished: idle.length };
  }
}
