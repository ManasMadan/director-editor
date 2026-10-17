import { describe, expect, it } from "vitest";
import { eventSubscribers, queues, type RoutedEvent } from "./queues";

/** Whether a value of type `U` is accepted where `T` is expected. */
type Takes<T, U> = [U] extends [T] ? true : false;

describe("event routing", () => {
  it("sends notification requests to the notification service only, never to the audit log", () => {
    expect(eventSubscribers["events-notifications"]("notification.requested.v1")).toBe(true);
    expect(eventSubscribers["events-audit"]("notification.requested.v1")).toBe(false);
    expect(eventSubscribers["events-audit"]("todo.created.v1")).toBe(true);
  });

  it("narrows a consumer's events to its route, so it can't handle one that never arrives", () => {
    const notified: RoutedEvent<"events-notifications">[] = [
      "notification.requested.v1",
      "email.feedback_received.v1",
    ];
    for (const name of notified) {
      expect(eventSubscribers["events-notifications"](name)).toBe(true);
    }
    // Checked by the compiler: an event the route doesn't list isn't one it handles.
    const unrouted: Takes<RoutedEvent<"events-notifications">, "todo.created.v1"> = false;
    const bumped: Takes<RoutedEvent<"events-notifications">, "notification.requested.v2"> = false;
    expect([unrouted, bumped]).toEqual([false, false]);
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
