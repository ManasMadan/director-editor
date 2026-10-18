/**
 * One activity line per procedure call (over /rpc and REST alike), from one interceptor
 * around every procedure (rpc.routes.ts): which procedure, who called it (the request
 * context, filled in by the procedure builders), how it ended, with the error's code, and
 * how long it took. Director's procedures are named for what they mean
 * (`director.take_recorded`); every other one is `api.called`.
 *
 * The target is read from an allow-list of ids and small facts in the input and the
 * answer (which video, shot and kind, the take or cut made, a publish's YouTube id),
 * never the rest: a body can hold a camera frame, a title someone typed, or a link.
 */
import type { ActivityName } from "@repo/contracts/activity";
import { MINUTE_MS } from "@repo/contracts/time";
import {
  type ActivityTarget,
  createActivityThrottle,
  currentContext,
  outcomeOf,
} from "@repo/nest-common";
import * as z from "zod";
import type { RecordActivity } from "../activity";

/** The procedures with a name of their own (the rest are `api.called`). */
const PROCEDURE_ACTIVITIES: Readonly<Record<string, ActivityName>> = {
  "director.index": "director.index_requested",
  "director.plan": "director.plan_opened",
  "director.checkScene": "director.scene_checked",
  "director.addTake": "director.take_recorded",
  "director.saveCut": "director.cut_saved",
  "director.media": "director.media_viewed",
  "publish.copy": "director.publish_copy_drafted",
  "publish.upload": "director.published",
};

/** A field kept only when it's there and of its type; anything else is left out. */
const text = z.string().max(200).optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
const count = z.number().int().optional().catch(undefined);

const inputFacts = z
  .object({
    videoId: text,
    shotIndex: count,
    kind: text,
    fileId: text,
    cutId: text,
    purpose: text,
    visibility: text,
  })
  .catch({});

const outputFacts = z
  .object({
    id: text,
    status: text,
    inPlace: flag,
    lighting: text,
    publish: z.object({ youtubeVideoId: text }).optional().catch(undefined),
  })
  .catch({});

/** A target's fields, those that are set. */
function defined(fields: Record<string, string | number | boolean | undefined>): ActivityTarget {
  const target: ActivityTarget = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
  return target;
}

/** What a call was about: the procedure, the input's ids, and the answer's. */
export function procedureTarget(procedure: string, input: unknown, output?: unknown) {
  const { publish, id, ...answer } = outputFacts.parse(output);
  return defined({
    procedure,
    ...inputFacts.parse(input),
    ...answer,
    resultId: id,
    youtubeVideoId: publish?.youtubeVideoId,
    count: Array.isArray(output) ? output.length : undefined,
  });
}

/**
 * Reads a screen asks for on a timer while something is in progress (a plan polled as
 * it's indexed, the media page, a scene checked every few seconds): logged at most once
 * per person, thing and THROTTLE_WINDOW_MS when they succeed, so a timeline shows that
 * someone opened them, not every poll. A failure is always logged.
 */
const THROTTLED: ReadonlySet<ActivityName> = new Set<ActivityName>([
  "director.plan_opened",
  "director.media_viewed",
  "director.scene_checked",
]);
const THROTTLE_WINDOW_MS = 5 * MINUTE_MS;

/** What makes two polls the same read: who, which, and of which short and shot. */
function throttleKey(activity: ActivityName, input: unknown) {
  const { videoId, shotIndex } = inputFacts.parse(input);
  return [currentContext()?.userId, activity, videoId, shotIndex].join("|");
}

/** The interceptor: one line per call, after it answers or throws. */
export function procedureActivity(
  record: RecordActivity,
  now: () => number = () => performance.now(),
  firstInWindow: (key: string) => boolean = createActivityThrottle(THROTTLE_WINDOW_MS),
) {
  return async <T>({
    next,
    path,
    input,
  }: {
    next: () => Promise<T>;
    path: readonly string[];
    input: unknown;
  }): Promise<T> => {
    const started = now();
    const procedure = path.join(".");
    const activity = PROCEDURE_ACTIVITIES[procedure] ?? "api.called";
    try {
      const output = await next();
      if (THROTTLED.has(activity) && !firstInWindow(throttleKey(activity, input))) {
        return output;
      }
      record({
        activity,
        target: procedureTarget(procedure, input, output),
        durationMs: now() - started,
      });
      return output;
    } catch (error) {
      record({
        activity,
        ...outcomeOf(error),
        target: procedureTarget(procedure, input),
        durationMs: now() - started,
      });
      throw error;
    }
  };
}
