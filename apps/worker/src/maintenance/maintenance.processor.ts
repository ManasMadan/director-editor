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
import type { OnApplicationBootstrap } from "@nestjs/common";
import { entriesOf } from "@repo/contracts/objects";
import {
  type JobName,
  jobName,
  parseJob,
  type QueueOf,
  queuePrefix,
  type UncheckedJob,
} from "@repo/jobs";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  JobProcessor,
  PinoLogger,
  row,
  runJob,
} from "@repo/nest-common";
import * as z from "zod";
import { env } from "../env";
import { FilesCleanup } from "../files/files.cleanup";
import { OUTBOX_SOURCES } from "../outbox/sources";

// What the retention functions return: how many they made, dropped or deleted.
const int = z.object({ n: z.number().int() });
const count = z.object({ n: z.bigint() });

type Task = JobName<"maintenance">;

/** When each task runs (cron, UTC). */
const SCHEDULES: Record<Task, string> = {
  "audit-partitions": "0 2 * * *",
  "outbox-retention": "15 3 * * *",
  "session-retention": "0 * * * *",
  "files-cleanup": "30 * * * *",
};

// Partitions exist this far around "now", so late and early timestamps always land.
const PARTITIONS_BACK = 1;
const PARTITIONS_AHEAD = 3;

@Processor("maintenance", { concurrency: 1, prefix: queuePrefix("maintenance") })
export class MaintenanceProcessor extends JobProcessor implements OnApplicationBootstrap {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @InjectQueue("maintenance") private readonly queue: QueueOf<"maintenance">,
    private readonly files: FilesCleanup,
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
      case "session-retention": {
        const purged = await row(count, db.$queryRaw`SELECT auth.purge_expired() AS n`);
        result.expired = Number(purged.n);
        break;
      }
    }
    this.log.info({ task, ...result }, "maintenance task finished");
    return result;
  }
}
