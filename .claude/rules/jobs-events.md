---
paths:
  - "packages/jobs/**"
  - "packages/contracts/src/events.ts"
  - "packages/nest-common/src/outbox.ts"
  - "apps/worker/**"
  - "apps/webhooks/**"
  - "apps/*/src/**/*.processor.ts"
---

# Queues, events and the outbox

- Every queue and job is declared once in `packages/jobs/src/queues.ts` with a zod
  payload and its retry options. Python gets the schemas through `bun run gen`.
- Producers use `createProducer(queue, connection).add(job, payload, { jobId, meta })`.
  `jobId` is required: the outbox event id, a delivery id or a UUIDv7, never a BullMQ
  auto id and never containing `:`. Pass `meta` (`requestId`, `userId`, `orgId` from
  `currentContext()`) so the consumer's logs join the request's.
- Consumers always start with `parseJob(queue, name, job.data)` (producer and consumer
  may be different versions mid-deploy) and run the handler inside `runWithContext`.
- Every handler is idempotent: jobs are retried and events are delivered at least once,
  in any order. Dedupe on a unique key (`skipDuplicates`, `ON CONFLICT`, the event id).
- Queues and processors use `prefix: queuePrefix(name)` (Redis Cluster hash tag).
- Domain events: `emitEvent(tx, "<domain>.<fact>.v<N>", key, payload)` inside the
  transaction that makes the change. It writes `<schema>.outbox_event` and the worker's
  `OutboxRelay` publishes it to the queues in `eventSubscribers`. Never enqueue an event
  directly from a request: a rollback would leave a published event for a change that
  never happened.
- Event payloads are a public contract (webhooks, audit log): add optional fields only;
  anything else is a new version published alongside the old one.
- A service that starts emitting events needs its own outbox and processed-event
  tables, the grants for `app_worker`, the purge functions, and an entry in
  `OUTBOX_SOURCES` (the checklist is in `apps/worker/src/outbox/sources.ts`).
- Scheduled jobs: add the job to `queues.maintenance.jobs`, its cron to `SCHEDULES` in
  `apps/worker/src/maintenance/maintenance.processor.ts`, and a case in `run()`.
  Retention work calls a narrowly granted `SECURITY DEFINER` function.
- Webhooks: inbound provider calls verify the signature on the raw body before anything
  else, store the event with a unique provider id and emit it; processing happens from
  the queue, never inline. Outbound deliveries are signed (`outbound/signing.ts`) and
  sent only through `safeFetch`.
- Never hold a database transaction open while awaiting Redis, BullMQ or HTTP.
