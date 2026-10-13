/**
 * Turns domain events into live UI nudges: a todo change tells everyone looking at that
 * organization's todos to refetch. Messages carry no data (see packages/contracts
 * realtime), so this needs no access checks of its own.
 *
 * To make another screen live: add its message type to the realtime contract, route
 * the events that affect it to events-realtime (eventSubscribers), map them below, and
 * refetch on the client in useLiveUpdates.
 */
import { Processor } from "@nestjs/bullmq";
import type { EventEnvelope } from "@repo/contracts/events";
import { type RealtimeMessage, realtimeChannel } from "@repo/contracts/realtime";
import { parseJob, queuePrefix, type UncheckedJob } from "@repo/jobs";
import { InjectRedis, JobProcessor, type Redis, runJob } from "@repo/nest-common";
import { publishRealtime } from "./publish";

/** The channel and message an event produces, if any. */
export function realtimeFor(
  event: EventEnvelope,
): { channel: string; message: RealtimeMessage } | undefined {
  if (event.name.startsWith("todo.") && event.orgId) {
    return { channel: realtimeChannel.org(event.orgId), message: { type: "todos.changed" } };
  }
  return undefined;
}

@Processor("events-realtime", { concurrency: 20, prefix: queuePrefix("events-realtime") })
export class RealtimeProcessor extends JobProcessor {
  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload: event } = parseJob("events-realtime", "event", job.data);
    const target = realtimeFor(event);
    if (!target) {
      return;
    }
    await runJob(meta, `event:${event.id}`, () =>
      publishRealtime(this.redis, target.channel, target.message),
    );
  }
}
