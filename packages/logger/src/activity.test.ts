import { describe, expect, it } from "vitest";
import { activityLine } from "./activity";

describe("an activity line", () => {
  it("takes what a sign-in logs", () => {
    const line = {
      activity: "auth.signed_in",
      actor: { userId: "u1", email: "ada@example.com", name: "Ada", demo: false },
      target: { method: "google" },
      outcome: "ok",
      ip: "203.0.113.9",
      userAgent: "Mozilla/5.0",
      requestId: "r1",
      traceId: "0af7651916cd43dd8448eb211c80319c",
    };
    expect(activityLine.parse(line)).toEqual(line);
  });

  it("refuses a nested target, which Grafana can't read as one field, and an unknown outcome", () => {
    const line = { activity: "api.called", actor: {}, outcome: "ok" };
    expect(activityLine.safeParse({ ...line, target: { a: { b: 1 } } }).success).toBe(false);
    expect(activityLine.safeParse({ ...line, outcome: "maybe" }).success).toBe(false);
  });
});
