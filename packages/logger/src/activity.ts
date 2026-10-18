/**
 * The shape of an activity line: one structured log line per meaningful thing someone
 * does (signing in, calling a procedure, indexing a short, publishing), written by every
 * service through its own logger and read in Grafana (docs/observability.md). Its fields
 * are defined here once; the activity names, which belong to the product, are in
 * @repo/contracts/activity, and `bun run gen` exports both to the Python service
 * (packages/jobs/scripts/export-schemas.ts). @repo/nest-common's `logActivity` fills a
 * line in from the request's context.
 */
import * as z from "zod";

/**
 * How it went: done, refused on purpose (a limit, a permission, the demo account, bad
 * input: a 4xx), or failed (our fault or a provider's: a 5xx).
 */
export const activityOutcome = z.enum(["ok", "refused", "failed"]);
export type ActivityOutcome = z.infer<typeof activityOutcome>;

/** Who did it. A failed sign-in has only the address that was tried. */
export const activityActor = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  demo: z.boolean().optional(),
});
export type ActivityActor = z.infer<typeof activityActor>;

/**
 * What it was about and its details: ids, a method, a score, a count. Flat and scalar,
 * so Grafana reads each as `target_<key>`. Never message content, a URL with a
 * signature, or anything a person typed.
 */
const activityTarget = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type ActivityTarget = z.infer<typeof activityTarget>;

/** One activity line, as it reaches the logs (besides the logger's own fields). */
export const activityLine = z.object({
  /** One of @repo/contracts/activity's ACTIVITIES. */
  activity: z.string(),
  actor: activityActor,
  orgId: z.string().optional(),
  target: activityTarget.optional(),
  outcome: activityOutcome,
  /** Why it was refused or failed: an error code, or a provider's reason. */
  reason: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  requestId: z.string().optional(),
  /** The trace, when tracing is on (Grafana links it to Jaeger). */
  traceId: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type ActivityLine = z.infer<typeof activityLine>;

/** The message every activity line is logged with, so a query can match it first. */
export const ACTIVITY_MESSAGE = "activity";
