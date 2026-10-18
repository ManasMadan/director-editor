/**
 * Activity lines: one structured log line per meaningful thing someone does, so the
 * owner can follow any person through the app in Grafana (docs/observability.md). The
 * line's shape is @repo/logger/activity's and the names are @repo/contracts/activity's
 * (a service names its activities with that type: `Activity<ActivityName>`); this fills
 * in who, from where and under which request from the request context, and writes the
 * line through the service's own logger (never a second logging library).
 *
 *   logActivity(this.log, { activity: "director.publish_started", target: { cutId } });
 *
 * The logger adds `traceId` itself when tracing is on (telemetry.ts), and every line
 * of the request carries its `requestId`, `userId` and `orgId` (logging.ts); the
 * person's email, name and address go on activity lines only.
 */
import { ERROR_CODES, isErrorCode } from "@repo/contracts/errors";
import { fieldOf } from "@repo/contracts/objects";
import {
  ACTIVITY_MESSAGE,
  type ActivityActor,
  type ActivityLine,
  type ActivityOutcome,
  type ActivityTarget,
} from "@repo/logger/activity";
import { currentContext } from "./context";

export type { ActivityOutcome, ActivityTarget };

export interface Activity<Name extends string = string> {
  activity: Name;
  /** "ok" unless said otherwise. */
  outcome?: ActivityOutcome;
  reason?: string | undefined;
  target?: ActivityTarget;
  durationMs?: number;
  /**
   * Who, where the request context doesn't know (a sign-in, before its session exists;
   * a background job, which has no request): merged over the context's.
   */
  actor?: ActivityActor;
  /** For a job, which runs outside any request: its workspace and the request that queued it. */
  orgId?: string | undefined;
  requestId?: string | undefined;
}

/** What an activity is written through: pino's (or nestjs-pino's) logger, or one like it. */
export interface ActivityLogger {
  info(line: object, message: string): void;
  warn(line: object, message: string): void;
}

/** The full line for an activity, with the request's actor, address and ids. */
export function activityLine(activity: Activity): ActivityLine {
  const context = currentContext();
  return {
    activity: activity.activity,
    actor: {
      userId: context?.userId,
      email: context?.email,
      name: context?.name,
      demo: context?.demo,
      ...activity.actor,
    },
    orgId: activity.orgId ?? context?.orgId,
    target: activity.target,
    outcome: activity.outcome ?? "ok",
    reason: activity.reason,
    ip: context?.ip,
    userAgent: context?.userAgent,
    requestId: activity.requestId ?? context?.requestId,
    durationMs: activity.durationMs === undefined ? undefined : Math.round(activity.durationMs),
  };
}

/** Writes an activity line: at warn when it failed (our fault), info otherwise. */
export function logActivity(log: ActivityLogger, activity: Activity) {
  const line = activityLine(activity);
  if (line.outcome === "failed") {
    log.warn(line, ACTIVITY_MESSAGE);
  } else {
    log.info(line, ACTIVITY_MESSAGE);
  }
}

/**
 * How a thrown error reads on an activity line: an error code of the catalog is refused
 * below 500 and failed from it, with the code as the reason; anything else failed, as
 * INTERNAL. Reads the code and status of an AppError and of the oRPC error it becomes.
 */
export function outcomeOf(error: unknown): { outcome: ActivityOutcome; reason: string } {
  const code = fieldOf(error, "code");
  if (!isErrorCode(code)) {
    return { outcome: "failed", reason: "INTERNAL" };
  }
  return { outcome: ERROR_CODES[code] < 500 ? "refused" : "failed", reason: code };
}

/**
 * Lets the first of each key through once a window, for activities a screen asks for on
 * a timer (a plan polled while it's indexed, a scene checked every few seconds): one line
 * per person, thing and window instead of one per poll. In memory, so each replica lets
 * its own first one through; that costs a line, never a Redis call on every poll. It
 * holds at most `maxKeys` keys: past that it forgets the expired ones, then every one.
 */
export function createActivityThrottle(windowMs: number, now = Date.now, maxKeys = 10_000) {
  const seen = new Map<string, number>();
  const forgetExpired = (at: number) => {
    for (const [key, last] of seen) {
      if (at - last >= windowMs) {
        seen.delete(key);
      }
    }
    if (seen.size >= maxKeys) {
      seen.clear();
    }
  };
  return (key: string): boolean => {
    const at = now();
    const last = seen.get(key);
    if (last !== undefined && at - last < windowMs) {
      return false;
    }
    if (seen.size >= maxKeys) {
      forgetExpired(at);
    }
    seen.set(key, at);
    return true;
  };
}
