/**
 * Every queue in the system, the jobs it carries (each with a zod payload schema), and
 * how long finished jobs are kept.
 *
 * This file is the contract between services, which never import each other's code
 * or call each other directly; they only exchange jobs and events. A producer can only
 * enqueue a job that exists here with a payload that type-checks, and a consumer
 * re-validates the payload before processing, because during a rolling deploy the
 * producer and consumer can be different versions.
 *
 * Direct jobs are for work that can be re-created if Redis is lost (an email, a
 * thumbnail). Anything that must never be lost is written to the database outbox in
 * the same transaction as the change and relayed to a queue from there.
 *
 * Python consumers (apps/ai) read the same queues; their Pydantic models are generated
 * from these schemas (see docs/jobs-and-events.md).
 */
import { type EventName, eventEnvelope, unauditedEvents } from "@repo/contracts/events";
import {
  directorPlanIdSchema,
  directorTakeIdSchema,
  fileIdSchema,
  orgIdSchema,
} from "@repo/contracts/ids";
import { DAY_S, HOUR_S, MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { locales } from "@repo/i18n";
import type { JobsOptions } from "bullmq";
import * as z from "zod";

/**
 * BullMQ key prefix for a queue: the queue name in braces, i.e. a Redis Cluster hash
 * tag. Every key of one queue lands in the same slot (BullMQ's Lua scripts need that),
 * while different queues spread across slots, so moving to a cluster needs no key
 * migration. Producers and consumers (Node and Python) must use exactly this prefix.
 * KEDA scales a queue's workers on `LLEN {<queue>}:<queue>:wait`, so queues that KEDA
 * scales must not use job priorities (prioritized jobs live in a separate sorted set).
 */
export const queuePrefix = (queue: string) => `{${queue}}`;

/**
 * Who and what caused a job, copied from the producer's request context. Workers
 * restore it before processing, so their logs carry the same request id as the HTTP
 * request that enqueued the job. Every job is stored as `{ meta, payload }`.
 */
export const jobMeta = z.object({
  requestId: z.string().optional(),
  userId: z.string().optional(),
  orgId: z.string().optional(),
});
export type JobMeta = z.infer<typeof jobMeta>;

const email = z.email();

/** Account changes the owner is emailed about, so a takeover can't happen silently. */
const SECURITY_EVENTS = [
  "email-changed",
  "password-changed",
  "password-reset",
  "two-factor-enabled",
  "two-factor-disabled",
  "passkey-added",
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
const locale = z.enum(locales);

/**
 * Notification templates, every one an email (sent to an address with its own locale).
 * The notification service owns rendering and delivery.
 */
export const notificationPayload = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("auth.otp"),
    // Codes can be sent before an account exists, so the recipient carries its own
    // locale (negotiated from the request).
    to: z.object({ email, locale }),
    data: z.object({
      otp: z.string(),
      purpose: z.enum(["sign-in", "email-verification", "forget-password", "change-email"]),
      expiresInMinutes: z.number().int().positive(),
    }),
  }),
  z.object({
    template: z.literal("auth.security-alert"),
    // Sent to the address that was on the account at the time: after an email change,
    // that is the old one, which is exactly who needs to hear about it.
    to: z.object({ email, locale }),
    data: z.object({
      event: z.enum(SECURITY_EVENTS),
      /** For email-changed: the address the account moved to. */
      newEmail: email.optional(),
      /** Where to review devices and change the password. */
      securityUrl: z.url(),
    }),
  }),
]);
export type NotificationPayload = z.infer<typeof notificationPayload>;
export type NotificationTemplate = NotificationPayload["template"];

/**
 * Retries with exponential backoff; the defaults every queue starts from. The jitter
 * spreads retries out, so jobs that failed together (a provider's outage) don't all come
 * back at the same moment.
 */
const retrying: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
};

export const queues = {
  /**
   * Time-critical notifications (sign-in codes, security alerts), delivered by
   * apps/notifications. Payloads can hold one-time codes, so they are deleted as soon as
   * they complete.
   */
  "notifications-critical": {
    jobs: { send: notificationPayload },
    options: { ...retrying, removeOnComplete: true, removeOnFail: { age: HOUR_S } },
  },
  /**
   * Domain events, one queue per consumer (see `eventSubscribers`). The relay in
   * apps/worker fills them from the outbox with jobId = event id, so a redelivered event
   * is ignored while its job is still kept; consumers are idempotent on the event id
   * beyond that window.
   */
  "events-audit": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 30 * DAY_S } },
  },
  /** Domain events that notify someone (apps/notifications maps them to templates). */
  "events-notifications": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 30 * DAY_S } },
  },
  /**
   * Checking uploads (apps/worker): type sniffing, virus scan, image re-encoding. The job
   * id is the file id, so completing an upload twice checks it once.
   */
  files: {
    jobs: { process: z.object({ fileId: fileIdSchema }) },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 7 * DAY_S } },
  },
  /**
   * Director (apps/ai produces and consumes it; the payload reaches Python as generated
   * Pydantic models, see scripts/export-schemas.ts): Gemini watches a YouTube short and
   * writes its shot plan, and reviews each take a member records for it. Model calls
   * cost money and a provider outage passes, so a few spaced retries, no more.
   */
  "ai-director": {
    jobs: {
      /** Work out how to film the plan's video. */
      plan: z.object({ planId: directorPlanIdSchema, orgId: orgIdSchema }),
      /**
       * Review a take. `sourceUrl` is a presigned read of the take's file (apps/api signs
       * it for 30 minutes): the AI service has no storage credentials of its own, and the
       * URL only ever sits in this queue, never in a table.
       */
      "review-take": z.object({
        takeId: directorTakeIdSchema,
        orgId: orgIdSchema,
        sourceUrl: z.url(),
      }),
    },
    options: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5 * SECOND_MS, jitter: 0.5 },
      removeOnComplete: { age: DAY_S },
      removeOnFail: { age: 7 * DAY_S },
    },
  },
  maintenance: {
    jobs: {
      "outbox-retention": z.object({}),
      "audit-partitions": z.object({}),
      "session-retention": z.object({}),
      "files-cleanup": z.object({}),
    },
    options: {
      attempts: 3,
      backoff: { type: "exponential", delay: MINUTE_MS, jitter: 0.5 },
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 30 * DAY_S },
    },
  },
} as const satisfies Record<string, { jobs: Record<string, z.ZodType>; options: JobsOptions }>;

export type QueueName = keyof typeof queues;
export type JobName<Q extends QueueName> = keyof (typeof queues)[Q]["jobs"] & string;
export type JobPayload<Q extends QueueName, J extends JobName<Q>> = z.infer<
  (typeof queues)[Q]["jobs"][J]
>;

/**
 * Who receives which domain events. The relay copies each event into every queue whose
 * filter accepts it. A new consumer gets a queue above and a line here; it sees events
 * from the moment it's added (older ones can be replayed from the outbox's retention).
 */
export const eventSubscribers = {
  "events-audit": (name: string) => !unauditedEvents.has(name),
  // Events that notify someone, and email feedback (bounces, complaints) to suppress.
  "events-notifications": only(["notification.requested.v1", "email.feedback_received.v1"]),
} as const satisfies Partial<Record<QueueName, (name: string) => boolean>>;
export type EventQueue = keyof typeof eventSubscribers;

/**
 * A filter passing exactly these events. It narrows the name, so a consumer that checks
 * it can only handle events routed to it: handling `todo.completed.v2` while the route
 * still names v1 fails to compile instead of never arriving.
 */
function only<const Name extends EventName>(names: readonly Name[]) {
  const routed: ReadonlySet<string> = new Set(names);
  return (name: string): name is Name => routed.has(name);
}

/** The event names a queue's filter passes, when it lists them. */
type Filter<Name extends string> = (name: string) => name is Name;
export type RoutedEvent<Q extends EventQueue> =
  (typeof eventSubscribers)[Q] extends Filter<infer Name> ? Name : string;
