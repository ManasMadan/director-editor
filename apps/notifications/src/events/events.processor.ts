/**
 * Domain events for the notification service. The event id is the idempotency key, so a
 * redelivered event notifies nobody twice.
 *
 *   - a notification asked for in the transaction of the change it's about (security
 *     alerts), sent as any queued one;
 *   - email feedback (our mail server's bounce or spam complaint, from apps/webhooks),
 *     which puts the address on the suppression list, so it's never emailed again.
 *
 * To notify on another event: route it here (`eventSubscribers["events-notifications"]`
 * in packages/jobs), add a template, and handle it below.
 */
import { Processor } from "@nestjs/bullmq";
import { events } from "@repo/contracts/events";
import {
  eventSubscribers,
  notificationPayload,
  parseJob,
  queuePrefix,
  type UncheckedJob,
} from "@repo/jobs";
import { JobProcessor, runJob } from "@repo/nest-common";
import { Dispatcher } from "../dispatch/dispatcher";
import { DeliveryPolicy } from "../dispatch/policy";

@Processor("events-notifications", { concurrency: 10, prefix: queuePrefix("events-notifications") })
export class EventsProcessor extends JobProcessor {
  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly policy: DeliveryPolicy,
  ) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload: event } = parseJob("events-notifications", "event", job.data);
    const { name } = event;
    // An event routed here by a newer relay this build doesn't know yet.
    if (!eventSubscribers["events-notifications"](name)) {
      return;
    }
    if (name === "email.feedback_received.v1") {
      const { address, kind } = events[name].parse(event.payload);
      await this.policy.suppress("email", address, kind);
      return;
    }
    const notification = notificationPayload.parse(events[name].parse(event.payload).notification);
    await runJob(meta, `event:${event.id}`, () => this.dispatcher.dispatch(notification, event.id));
  }
}
