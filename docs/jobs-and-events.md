# Jobs and events

Services never call each other. Work leaves a request in one of two ways:

- **A job**, added straight to a BullMQ queue: for work that can be re-created if Redis
  is lost (an email, an upload check).
- **A domain event**, written to the database outbox in the same transaction as the
  change it describes, then relayed to one queue per consumer: for facts that must
  never be lost or invented (the audit log, security alerts).

Everything is in two files: `packages/jobs/src/queues.ts` (every queue, its jobs' zod
schemas and retry options, and which consumers receive which events) and
`packages/contracts/src/events.ts` (every event and its payload).

## Typed jobs

```ts
const files = createProducer("files", redis);
await files.add("process", { fileId }, { jobId: fileId, meta: { requestId } });
```

`createProducer` checks the job name and payload against `queues` at compile time and
validates the payload before writing it. `jobId` is required and chosen by the producer
(a UUID, the file id, the event id): BullMQ ignores a second add with the same id while
the job is kept, so a retried request never enqueues twice, and consumers use it as the
idempotency key towards providers. Ids can't contain `:`.

Consumers are Nest `@Processor`s with the queue's prefix, and re-validate every job,
because producer and consumer can be different versions during a rolling deploy:

```ts
@Processor("files", { concurrency: env.FILES_CONCURRENCY, prefix: queuePrefix("files") })
export class FilesProcessor extends JobProcessor {
  async process(job: UncheckedJob) {
    const { meta, payload } = parseJob("files", "process", job.data);
    ...
  }
}
```

A job comes in as an `UncheckedJob` (`@repo/jobs`): its data is `unknown` until
`parseJob` checks it, and its name is any string until `jobName` checks it against the
queue's jobs (a newer producer may have added one this build doesn't know). `idOf`
returns its id. A queue a service adds to directly, like a job scheduler's template, is
a `QueueOf<"<queue>">`, so its job names and data are checked when it compiles.

`JobProcessor` (`@repo/nest-common`) is `WorkerHost` plus logging: every failed job is
logged with its queue, id, attempt and the error's causes, as "job failed; it will be
retried" or "job failed for good", and worker errors too. A test fails any processor
that extends `WorkerHost` directly. `parseJob` throws BullMQ's `UnrecoverableError` for
a payload that doesn't match its schema, so that job fails at once instead of retrying.

Jobs are stored as `{ meta, payload }`. `meta` carries the producer's request id, user
and organization; consumers restore it with `runWithContext`, so their logs share the
request id of the HTTP call that caused them.

Every queue's Redis keys use the prefix `{<queue>}` (`queuePrefix`), a Redis Cluster
hash tag, so moving to a cluster needs no key migration. KEDA scales workers on
`LLEN {<queue>}:<queue>:wait`, so queues KEDA scales must not use job priorities. Its
operator reads that from the `keda` namespace, which is why Valkey's network policy
lets it in (`deploy/charts/data/templates/valkey.yaml`).

## Queues

| Queue | Jobs | Produced by | Consumed by |
|---|---|---|---|
| `notifications-critical` | `send` | api (sign-in codes) | notifications |
| `events-audit` | `event` | the outbox relay | worker (audit log) |
| `events-notifications` | `event` | the outbox relay | notifications (security alerts, and suppressing an address that hard-bounced) |
| `files` | `process` | api (upload completed) | worker |
| `ai-director` | `plan`, `review-take` | ai (FastAPI and its worker) | ai worker (Python) |
| `maintenance` | `outbox-retention`, `audit-partitions`, `session-retention`, `files-cleanup` | worker (job schedulers) | worker |

Scheduled work uses BullMQ job schedulers upserted at boot (`maintenance.processor.ts`),
so each occurrence runs once whatever the replica count.

## Retries and failed jobs

Most queues retry 5 times with exponential backoff from 2 s, with jitter (each delay
somewhere in its upper half) so jobs that failed together don't all return at once.
`ai-director` retries 3 times from 5 s (model calls cost money, and a provider outage
passes), and `maintenance` 3 times from a minute.

A job that fails validation or runs out of attempts stays in BullMQ's failed set for
its queue's `removeOnFail` age: an hour on `notifications-critical` (its payloads can
hold one-time codes), 30 days on the event queues and `maintenance`, and 7 days on the
rest. There is no
separate dead-letter queue; the failed set is it. `bun run jobs` shows every queue's
counts, `bun run jobs failed <queue>` lists failed jobs and why, and `retry` or
`discard` put them back or drop them (`scripts/jobs.ts`, on `packages/jobs/src/admin.ts`;
header comment for pointing it at a deployed environment). A retried job starts over
with its full retry schedule.

## The transactional outbox

```ts
await transaction(database.write, async (tx) => {
  await tx.user.update(...);
  await emitEvent(tx, "auth.password_changed.v1", userId, { userId });
});
```

`emitEvent` (from `createOutbox` in `packages/nest-common/src/outbox.ts`, bound per
service in its `src/outbox.ts`) validates the payload against the catalog, inserts a row
into the service's `<schema>.outbox_event` with the actor and request id from the
request context and the organization the transaction runs as (`tenantTx`, else the
request's, unless an origin says otherwise; so a job, script or seed gets it right too),
and sends `pg_notify('outbox', …)`, delivered on commit. It
only accepts a `Tx`, so an event outside a transaction doesn't compile: the change and
its event commit together or not at all.

Today `app` (api) and `webhooks` have outboxes (`OUTBOX_SOURCES` in
`apps/worker/src/outbox/sources.ts`). Account-security events from better-auth are the
exception: better-auth commits its own writes, so the API records those events in a
transaction just after.

### The relay (apps/worker)

`OutboxRelay` (`apps/worker/src/outbox/relay.service.ts`) claims up to
`RELAY_BATCH_SIZE` unpublished rows with `FOR UPDATE SKIP LOCKED`, publishes them,
stamps `published_at` and commits. Any number of worker replicas run it at once, each
getting different rows. It wakes on `LISTEN outbox` through `WORKER_DATABASE_DIRECT_URL`
(a pooler would drop the listener) and also polls every `RELAY_POLL_INTERVAL_MS`, so a
lost notification only delays events.

The relay hands batches to the `EventBus` (`event-bus.ts`). The BullMQ implementation
copies each event into every queue whose filter in `eventSubscribers` accepts it, with
`jobId` = event id. A crash between publishing and committing republishes the batch;
the job id drops the duplicate while the job is kept.

Published rows stay for `OUTBOX_RETENTION_DAYS`, the window in which events can be
replayed to a new consumer.

### Delivery guarantees

At least once, unordered. Consumers are idempotent:

- audit: the row id is the event id (`skipDuplicates`);
- notifications: each (job, recipient) is claimed in the delivery log before sending,
  keyed on the job id (the event id for event-driven notifications).

Each outbox schema also has `processed_event (event_id, consumer)` for a consumer that
can't be idempotent by construction; the current consumers don't need it.

An outbox row that isn't a valid event (a bad name, say) would fail its batch, and every
batch after it, forever: the relay logs it ("outbox row isn't a valid event; set
aside") and marks it published, so it stays in the table for someone to look at until
retention removes it.

An event's name is accepted by the relay even if that build doesn't know it (a newer
service can emit it mid-deploy); each consumer ignores names it doesn't handle.

For HTTP mutations that must not run twice, `IdempotencyStore`
(`packages/nest-common/src/idempotency.ts`) stores the result under a caller-scoped key
for 24 hours.

## Events

Names are versioned (`auth.signed_up.v1`). Adding an optional field is compatible;
anything else is a new version, published alongside the old one until every consumer
has moved. CI holds this: `bun run gen` writes every event's schema to
`packages/jobs/generated/events.json`, and on a pull request `scripts/events-compat.ts`
compares it with the base branch's, failing on a removed event or a field removed,
retyped, made required or made optional. The audit log records every event except `notification.requested.v1`
(`unauditedEvents`): its payload is a whole notification, addresses included, and the
change it's about has its own event.

| Events | Emitted by | Also consumed by |
|---|---|---|
| `auth.signed_up.v1`, `auth.session_started.v1`, `auth.session_ended.v1`, `auth.password_changed.v1`, `auth.password_reset.v1`, `auth.email_changed.v1`, `auth.two_factor_changed.v1`, `auth.passkey_added.v1`, `auth.account_deleted.v1` | api (auth) | |
| `org.created.v1`, `org.deleted.v1`, `org.member_added.v1`, `org.member_removed.v1`, `org.member_role_changed.v1`, `org.invitation_sent.v1` | api (auth) | |
| `notification.requested.v1` | api (security alerts) | notifications |
| `email.feedback_received.v1` | webhooks (`/webhooks/stalwart`: a hard bounce from our mail server) | notifications (suppresses the address) |

The catalog still names the events of features Director removed (todos, API keys,
connected apps, phone numbers, outbound webhooks, Stripe): nothing emits them, and they
stay so the events-compat check and the audit log's labels for past rows keep working.

## The Python worker

`apps/ai` produces and consumes `ai-director` with the Python `bullmq` package. Its job
payloads are the Pydantic models generated from the zod schemas, one per job
(`app/contracts/ai_director_plan_job.py`, `ai_director_review_take_job.py`), and its
prefix and retry options come from `app/contracts/queue_settings.json`, generated from
`queues` (see [codegen.md](codegen.md)). It publishes live nudges on the same Redis
pub/sub channels as the TypeScript services, validated against the generated
`RealtimeMessage`.

## Realtime

The worker (a checked upload: `files.changed`) and the AI service (a plan or a take that
changed: `director.changed`) publish messages on Redis pub/sub (`realtime:<channel>`);
each API process subscribes for
its open streams and forwards them over the `realtime` procedure (server-sent events on
`/rpc`). Messages only say "refetch", so a missed one costs freshness, not correctness.

## Adding a job

1. Add the queue (or a job on an existing one) to `queues` in `packages/jobs/src/queues.ts`
   with its zod payload and options. A new notification template instead goes in
   `notificationPayload` (see [notifications.md](notifications.md)).
2. Produce it with `createProducer(queue, redis).add(job, payload, { jobId, meta })`.
3. Consume it with a `@Processor(queue, { prefix: queuePrefix(queue) })` that calls
   `parseJob`, registered in the consuming service's module
   (`BullModule.registerQueue({ name, prefix: queuePrefix(name) })`).
4. If KEDA should scale it, add it to the service's `keda.queues` in
   `deploy/charts/stack/values.yaml`.
5. If Python consumes it, add it to `packages/jobs/scripts/export-schemas.ts` and run
   `bun run gen`.

## Adding an event

1. Define its payload in `events` in `packages/contracts/src/events.ts`.
2. Emit it with `emitEvent(tx, name, key, payload)` in the same transaction as the change.
3. Route it to the consumers that need it in `eventSubscribers`
   (`packages/jobs/src/queues.ts`). The audit log needs nothing.
4. A new consumer gets its own `events-<name>` queue in `queues` and a line in
   `eventSubscribers`; it sees events from then on (older ones can be replayed from the
   outbox's retention window).

A service that starts emitting events adds its schema to `OUTBOX_SOURCES`, and its
migration creates `<schema>.outbox_event` and `<schema>.processed_event`, grants
`app_worker` `SELECT` and `UPDATE (published_at)` on the outbox, and adds the two
retention functions (`purge_published_outbox`, `purge_processed_events`) with `EXECUTE`
for `app_worker`, like the `audit_log_and_retention` migration does for `app`.
