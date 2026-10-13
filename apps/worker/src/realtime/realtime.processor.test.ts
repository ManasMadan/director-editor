import { describe, expect, it } from "vitest";
import { realtimeFor } from "./realtime.processor";

const event = (name: string, orgId: string | null = "01a0ea00-0000-7000-8000-000000000001") =>
  ({
    id: "01a0ea00-0000-7000-8000-000000000002",
    name,
    key: "k",
    payload: {},
    orgId,
    actorId: null,
    requestId: null,
    occurredAt: new Date().toISOString(),
    source: "app",
  }) as never;

describe("realtimeFor", () => {
  it("nudges the organization's channel when its todos change", () => {
    expect(realtimeFor(event("todo.completed.v1"))).toEqual({
      channel: "org:01a0ea00-0000-7000-8000-000000000001",
      message: { type: "todos.changed" },
    });
  });

  it("ignores events without an organization or a live screen", () => {
    expect(realtimeFor(event("todo.created.v1", null))).toBeUndefined();
    expect(realtimeFor(event("auth.password_changed.v1"))).toBeUndefined();
  });
});
