/**
 * The names of the activity logs: one structured log line per meaningful thing someone
 * does, written by every service and read in Grafana (docs/observability.md). The line's
 * shape is the logger's (@repo/logger/activity); the names, which are the product's, are
 * here, and `bun run gen` exports both to the Python service
 * (packages/jobs/scripts/export-schemas.ts).
 *
 * Unlike domain events (events.ts), activities are not a contract with any consumer and
 * are not stored: they are logs, for following one person through the app. A name can be
 * renamed or dropped, at the cost of the Grafana queries that use it
 * (deploy/platform/dashboards).
 *
 * Product analytics (BigQuery's `director.events`, written by apps/api's AnalyticsService
 * and apps/ai's app/analytics.py) keeps its own kinds, also defined here, since its
 * reports read those spellings.
 */
import * as z from "zod";

/** Every activity, by domain. A new one goes here first; both languages pick it up. */
export const ACTIVITIES = [
  // An account was made: by email and password (verified later), or from Google.
  "auth.signed_up",
  // A sign-in, with its method; a failed one with better-auth's reason.
  "auth.signed_in",
  "auth.signed_out",
  // A session ended some other way than signing out (revoked, a password change, ...).
  "auth.session_revoked",
  // A Google account was linked to the person's own, or granted YouTube uploads.
  "auth.google_linked",
  "auth.youtube_granted",
  // The shared demo account tried something it may not do.
  "auth.demo_refused",
  // Any other API procedure call (the Director ones below have their own names).
  "api.called",
  "director.index_requested",
  // The AI worker finished watching a short: ok, failed, or refused (out of budget).
  "director.indexed",
  // The AI worker drew the default image of one of a plan's assets: ok, failed, or
  // refused (out of budget).
  "director.asset_drawn",
  // A member described a template: Director brainstormed a turn, the plan was asked for,
  // and the AI worker wrote it (ok, failed, or refused out of budget).
  "director.brainstormed",
  "director.create_requested",
  "director.created",
  "director.plan_edited",
  "director.plan_opened",
  "director.call_started",
  "director.call_ended",
  "director.take_recorded",
  "director.take_reviewed",
  "director.cut_saved",
  // A request in the editor, typed or said: its outcome and how many edits it made.
  "director.editor_request",
  "director.publish_copy_drafted",
  // The cut was claimed and its video is on its way to YouTube.
  "director.publish_started",
  // The publish call's end: ok (on YouTube), refused (its code) or failed.
  "director.published",
  "director.media_viewed",
  // A background job ran (worker, notifications, ai worker), for the user it ran for.
  "job.finished",
] as const;
export const activityName = z.enum(ACTIVITIES);
export type ActivityName = z.infer<typeof activityName>;

/**
 * The product analytics kinds (BigQuery `director.events`): what a Looker Studio report
 * counts. Both apps/api and apps/ai record them, with these spellings.
 */
export const ANALYTICS_KINDS = [
  "indexed",
  "take_reviewed",
  "cut_saved",
  "published",
  "call_started",
] as const;
export const analyticsKind = z.enum(ANALYTICS_KINDS);
export type AnalyticsKind = z.infer<typeof analyticsKind>;
