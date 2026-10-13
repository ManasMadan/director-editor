/**
 * Every schema that has an outbox (`<schema>.outbox_event`), i.e. every service that
 * emits domain events. Each service writes only its own outbox, in the same transaction
 * as its change; the relay drains them all.
 *
 * A service that starts emitting events adds its schema here, and its migration creates
 * `<schema>.outbox_event` and `<schema>.processed_event` like app's, grants app_worker
 * SELECT and UPDATE (published_at) on the outbox, and adds the two retention functions
 * (`<schema>.purge_published_outbox`, `<schema>.purge_processed_events`) with EXECUTE
 * for app_worker. See the audit_log_and_retention migration for the pattern.
 */
export const OUTBOX_SOURCES = ["app", "webhooks"] as const;
export type OutboxSource = (typeof OUTBOX_SOURCES)[number];
