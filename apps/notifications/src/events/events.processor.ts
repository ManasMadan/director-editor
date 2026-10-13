/**
 * Domain events that notify someone, mapped to notification templates. The event id is
 * the idempotency key, so a redelivered event notifies nobody twice.
 *
 * To notify on another event: route it here (`eventSubscribers["events-notifications"]`
 * in packages/jobs), add a template, and map it below. Only routed names compile below.
 *
 * Email feedback (a provider's bounce or spam complaint, from apps/webhooks) goes to the
 * suppression list instead, so the address is never emailed again.
 */
import { Processor } from "@nestjs/bullmq";
import { type EventEnvelope, events } from "@repo/contracts/events";
import {
  eventSubscribers,
  type NotificationPayload,
  notificationPayload,
  parseJob,
  queuePrefix,
  type RoutedEvent,
  type UncheckedJob,
} from "@repo/jobs";
import { JobProcessor, runJob } from "@repo/nest-common";
import { Dispatcher } from "../dispatch/dispatcher";
import { DeliveryPolicy } from "../dispatch/policy";

type Routed = EventEnvelope & {
  name: Exclude<RoutedEvent<"events-notifications">, "email.feedback_received.v1">;
};

function notificationFor(event: Routed): NotificationPayload | undefined {
  switch (event.name) {
    // Asked for in the transaction of the change it's about (security alerts).
    case "notification.requested.v1":
      return notificationPayload.parse(events[event.name].parse(event.payload).notification);
    case "webhook.endpoint_disabled.v1": {
      if (!event.orgId) {
        return undefined;
      }
      const payload = events[event.name].parse(event.payload);
      return {
        template: "webhooks.endpoint-disabled",
        to: { orgId: event.orgId, roles: ["owner", "admin"] },
        data: { endpointId: payload.endpointId, url: payload.url },
      };
    }
    case "org.api_key_created.v1":
    case "webhook.endpoint_created.v1": {
      if (!event.orgId) {
        return undefined;
      }
      const apiKey = event.name === "org.api_key_created.v1";
      const label = apiKey
        ? events["org.api_key_created.v1"].parse(event.payload).name
        : events["webhook.endpoint_created.v1"].parse(event.payload).url;
      return {
        template: "workspace.access-created",
        to: { orgId: event.orgId, roles: ["owner", "admin"] },
        data: { kind: apiKey ? "api-key" : "webhook-endpoint", label },
      };
    }
  }
}

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
    const notification = notificationFor({ ...event, name });
    if (!notification) {
      return;
    }
    await runJob(meta, `event:${event.id}`, () => this.dispatcher.dispatch(notification, event.id));
  }
}
