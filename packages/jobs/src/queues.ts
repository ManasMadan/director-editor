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
import {
  type EventName,
  eventEnvelope,
  unauditedEvents,
  webhookEvents,
} from "@repo/contracts/events";
import {
  documentIdSchema,
  fileIdSchema,
  orgIdSchema,
  todoIdSchema,
  userIdSchema,
  webhookDeliveryIdSchema,
  webhookEndpointIdSchema,
} from "@repo/contracts/ids";
import { DAY_S, HOUR_MS, HOUR_S, MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
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
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);

/**
 * Account changes the owner is told about (by email, and by text when they have a
 * verified phone), so a takeover can't happen silently.
 */
const SECURITY_EVENTS = [
  "email-changed",
  "password-changed",
  "password-reset",
  "two-factor-enabled",
  "two-factor-disabled",
  "passkey-added",
  "phone-added",
  "phone-removed",
  "app-connected",
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
const locale = z.enum(locales);

/** Notification templates. The notification service owns rendering and channels. */
export const notificationPayload = z.discriminatedUnion("template", [
  z.object({
    template: z.literal("auth.otp"),
    // Codes can be sent before an account exists, so the recipient carries its own
    // locale (negotiated from the request); user-addressed templates use the user's saved one.
    to: z.object({ email, locale }),
    data: z.object({
      otp: z.string(),
      purpose: z.enum(["sign-in", "email-verification", "forget-password", "change-email"]),
      expiresInMinutes: z.number().int().positive(),
    }),
  }),
  z.object({
    template: z.literal("auth.phone-code"),
    // Texted to a number being verified, which isn't on the account yet.
    to: z.object({ phone, locale }),
    data: z.object({ code: z.string(), expiresInMinutes: z.number().int().positive() }),
  }),
  z.object({
    template: z.literal("org.invitation"),
    // Invitees may not have an account yet, so the address carries its own locale.
    to: z.object({ email, locale }),
    data: z.object({
      organizationName: z.string(),
      inviterName: z.string(),
      acceptUrl: z.url(),
      expiresInDays: z.number().int().positive(),
    }),
  }),
  z.object({
    template: z.literal("auth.security-alert"),
    // Sent to the address that was on the account at the time: after an email change,
    // that is the old one, which is exactly who needs to hear about it. Also texted to
    // the verified phone, if any (after a phone change, the old number).
    to: z.object({ email, locale, phone: phone.optional() }),
    data: z.object({
      event: z.enum(SECURITY_EVENTS),
      /** For email-changed: the address the account moved to. */
      newEmail: email.optional(),
      /** Where to review devices and change the password. */
      securityUrl: z.url(),
    }),
  }),
  z.object({
    // Someone created a way into the workspace that outlives their session: its owners
    // and admins hear about it, so a stolen session can't leave one behind unseen.
    template: z.literal("workspace.access-created"),
    to: z.object({
      orgId: orgIdSchema,
      roles: z.array(z.enum(["owner", "admin", "member"])).min(1),
    }),
    data: z.object({
      kind: z.enum(["api-key", "webhook-endpoint"]),
      /** The key's name or the endpoint's URL. */
      label: z.string(),
    }),
  }),
  z.object({
    template: z.literal("webhooks.endpoint-disabled"),
    // Everyone in the organization with one of these roles.
    to: z.object({
      orgId: orgIdSchema,
      roles: z.array(z.enum(["owner", "admin", "member"])).min(1),
    }),
    data: z.object({ endpointId: webhookEndpointIdSchema, url: z.string() }),
  }),
  z.object({
    template: z.literal("billing.payment-failed"),
    to: z.object({
      orgId: orgIdSchema,
      roles: z.array(z.enum(["owner", "admin", "member"])).min(1),
    }),
    data: z.object({
      organizationName: z.string(),
      /** Minor units (cents), and an ISO 4217 code. */
      amount: z.number().int().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      billingUrl: z.url(),
    }),
  }),
  z.object({
    template: z.literal("todo.reminder"),
    to: z.object({ userId: userIdSchema }),
    data: z.object({ todoId: todoIdSchema, title: z.string() }),
  }),
]);
export type NotificationPayload = z.infer<typeof notificationPayload>;

/**
 * One channel of a notification, delayed until the recipient's quiet hours end. Keeps
 * the original delivery key, so it still can't be sent twice.
 */
const deferredDelivery = z.object({
  payload: notificationPayload,
  // Only push waits for quiet hours today: texts are security messages, which never wait.
  channel: z.enum(["push"]),
  userId: userIdSchema,
  key: z.string(),
});
export type NotificationTemplate = NotificationPayload["template"];

/**
 * When failed webhook deliveries are retried, after the first attempt (Standard Webhooks'
 * recommended schedule): 5s, 5m, 30m, 2h, 5h, 10h, 10h.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [
  5 * SECOND_MS,
  5 * MINUTE_MS,
  30 * MINUTE_MS,
  2 * HOUR_MS,
  5 * HOUR_MS,
  10 * HOUR_MS,
  10 * HOUR_MS,
];

const aiDocumentJob = z.object({ documentId: documentIdSchema, orgId: orgIdSchema });

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
   * Time-critical notifications (sign-in codes, security alerts, billing failures). Its
   * own queue and worker pool so a large digest can never delay a sign-in code.
   * Payloads can hold one-time codes, so they are deleted as soon as they complete.
   */
  "notifications-critical": {
    jobs: { send: notificationPayload, deferred: deferredDelivery },
    options: { ...retrying, removeOnComplete: true, removeOnFail: { age: HOUR_S } },
  },
  /** Everything else users are notified about: reminders, digests, product updates. */
  "notifications-bulk": {
    jobs: {
      send: notificationPayload,
      deferred: deferredDelivery,
      /** Hourly: queues a `digest` for each user whose digest time has come today. */
      digests: z.object({}),
      /** One user's daily digest email, for one local date (YYYY-MM-DD). */
      digest: z.object({ userId: userIdSchema, date: z.iso.date() }),
    },
    options: {
      ...retrying,
      removeOnComplete: { age: DAY_S, count: 10_000 },
      removeOnFail: { age: 7 * DAY_S },
    },
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
  "events-webhooks": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 30 * DAY_S } },
  },
  /** Domain events that notify someone (apps/notifications maps them to templates). */
  "events-notifications": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 30 * DAY_S } },
  },
  /** Live UI updates (apps/worker → Redis pub/sub → the api's SSE streams); short-lived. */
  "events-realtime": {
    jobs: { event: eventEnvelope },
    options: {
      attempts: 3,
      backoff: { type: "fixed", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: { age: DAY_S },
    },
  },
  "events-billing": {
    jobs: { event: eventEnvelope },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 30 * DAY_S } },
  },
  /**
   * Outgoing customer webhooks (apps/webhooks). One job per delivery (jobId = delivery
   * id); retried on the Standard Webhooks schedule (`WEBHOOK_RETRY_DELAYS_MS`) through
   * the worker's custom backoff, so a failing endpoint is tried for about a day.
   */
  "webhook-deliveries": {
    jobs: {
      deliver: z.object({ deliveryId: webhookDeliveryIdSchema, orgId: orgIdSchema }),
      /** Send an existing delivery again (admin replay from the delivery log). */
      redeliver: z.object({ deliveryId: webhookDeliveryIdSchema, orgId: orgIdSchema }),
      /** A test event to one endpoint, from its settings page. */
      "send-test": z.object({ endpointId: webhookEndpointIdSchema, orgId: orgIdSchema }),
    },
    options: {
      attempts: 8,
      backoff: { type: "webhook" },
      removeOnComplete: { age: DAY_S },
      removeOnFail: { age: 7 * DAY_S },
    },
  },
  /** Scheduled housekeeping in apps/worker (retention, partitions). */
  /**
   * Checking uploads (apps/worker): type sniffing, virus scan, image re-encoding. The job
   * id is the file id, so completing an upload twice checks it once.
   */
  files: {
    jobs: { process: z.object({ fileId: fileIdSchema }) },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 7 * DAY_S } },
  },
  /**
   * Indexing a document for the assistant (apps/ai produces and consumes it; the payload
   * reaches Python as generated Pydantic models, see scripts/export-schemas.ts).
   */
  "ai-ingest": {
    jobs: {
      /** Split and embed a document. */
      ingest: aiDocumentJob,
      /** Summarize an indexed document (queued after indexing when a model is configured). */
      summarize: aiDocumentJob,
    },
    options: { ...retrying, removeOnComplete: { age: DAY_S }, removeOnFail: { age: 7 * DAY_S } },
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

/** Which notification queue a template goes to. A new template must pick one. */
export const notificationQueue = {
  "auth.otp": "notifications-critical",
  "auth.phone-code": "notifications-critical",
  "org.invitation": "notifications-critical",
  "auth.security-alert": "notifications-critical",
  "webhooks.endpoint-disabled": "notifications-critical",
  "workspace.access-created": "notifications-critical",
  "billing.payment-failed": "notifications-critical",
  "todo.reminder": "notifications-bulk",
} as const satisfies Record<NotificationTemplate, keyof typeof queues>;
export type NotificationQueue = (typeof notificationQueue)[NotificationTemplate];

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
  "events-webhooks": only(webhookEvents),
  // Stripe's events, and membership changes (paid plans are billed per seat).
  "events-billing": only([
    "stripe.event_received.v1",
    "org.member_added.v1",
    "org.member_removed.v1",
  ]),
  // Events that notify someone, and email feedback (bounces, complaints) to suppress.
  "events-notifications": only([
    "webhook.endpoint_disabled.v1",
    "org.api_key_created.v1",
    "webhook.endpoint_created.v1",
    "notification.requested.v1",
    "email.feedback_received.v1",
  ]),
  "events-realtime": (name: string) => name.startsWith("todo."),
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
