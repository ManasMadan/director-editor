import { describe, expect, it } from "vitest";
import { eventSubscribers, queues, type RoutedEvent } from "./queues";

/** Whether a value of type `U` is accepted where `T` is expected. */
type Takes<T, U> = [U] extends [T] ? true : false;

describe("event routing", () => {
  it("sends the creation of a way into a workspace to the notification service", () => {
    const notifies = eventSubscribers["events-notifications"];
    expect(notifies("org.api_key_created.v1")).toBe(true);
    expect(notifies("webhook.endpoint_created.v1")).toBe(true);
    expect(notifies("todo.created.v1")).toBe(false);
  });

  it("sends notification requests to the notification service only, never to the audit log", () => {
    expect(eventSubscribers["events-notifications"]("notification.requested.v1")).toBe(true);
    expect(eventSubscribers["events-audit"]("notification.requested.v1")).toBe(false);
    expect(eventSubscribers["events-webhooks"]("notification.requested.v1")).toBe(false);
    expect(eventSubscribers["events-audit"]("todo.created.v1")).toBe(true);
  });

  it("narrows a consumer's events to its route, so it can't handle one that never arrives", () => {
    const billing: RoutedEvent<"events-billing">[] = [
      "stripe.event_received.v1",
      "org.member_added.v1",
      "org.member_removed.v1",
    ];
    for (const name of billing) {
      expect(eventSubscribers["events-billing"](name)).toBe(true);
    }
    // Checked by the compiler: an event the route doesn't list isn't a billing event.
    const unrouted: Takes<RoutedEvent<"events-billing">, "todo.created.v1"> = false;
    const bumped: Takes<RoutedEvent<"events-notifications">, "notification.requested.v2"> = false;
    expect([unrouted, bumped]).toEqual([false, false]);
  });

  it("sends billing its Stripe events and seat changes, and live screens their todos", () => {
    const bills = eventSubscribers["events-billing"];
    expect(bills("stripe.event_received.v1")).toBe(true);
    expect(bills("org.member_added.v1")).toBe(true);
    expect(bills("org.member_removed.v1")).toBe(true);
    expect(bills("todo.created.v1")).toBe(false);
    expect(eventSubscribers["events-realtime"]("todo.completed.v1")).toBe(true);
    expect(eventSubscribers["events-realtime"]("org.member_added.v1")).toBe(false);
  });

  it("retries with jitter, so jobs that failed together don't all come back at once", () => {
    for (const [name, queue] of Object.entries(queues)) {
      const backoff = queue.options.backoff as { type?: string; jitter?: number } | undefined;
      if (backoff?.type === "exponential") {
        expect(backoff.jitter, name).toBeGreaterThan(0);
      }
    }
  });
});
