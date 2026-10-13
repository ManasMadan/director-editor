/**
 * Writes every domain event to the audit log (audit.audit_log). Idempotent by
 * construction: the row key is the event id, so a redelivered event inserts nothing.
 */
import { Processor } from "@nestjs/bullmq";
import { parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import { type Database, InjectDatabase, JobProcessor, runJob } from "@repo/nest-common";
import { env } from "../env";

@Processor("events-audit", {
  concurrency: env.AUDIT_CONCURRENCY,
  prefix: queuePrefix("events-audit"),
})
export class AuditProcessor extends JobProcessor {
  constructor(@InjectDatabase() private readonly database: Database) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload: event } = parseJob("events-audit", "event", job.data);
    await runJob(meta, `event:${event.id}`, () =>
      this.database.write.auditLog.createMany({
        data: [
          {
            id: event.id,
            occurredAt: new Date(event.occurredAt),
            name: event.name,
            key: event.key,
            payload: event.payload ?? {},
            orgId: event.orgId,
            actorId: event.actorId,
            requestId: event.requestId,
            source: event.source,
          },
        ],
        skipDuplicates: true,
      }),
    );
  }
}
