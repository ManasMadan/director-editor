import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { DeliveryPolicy } from "../dispatch/policy";
import { EventsProcessor } from "./events.processor";

const job = (name: string, payload: unknown) =>
  ({
    data: {
      meta: {},
      payload: {
        id: randomUUID(),
        name,
        key: "k",
        payload,
        orgId: randomUUID(),
        actorId: null,
        requestId: null,
        occurredAt: new Date().toISOString(),
        source: "app",
      },
    },
  }) as unknown as Job;

describe("events the notification service isn't routed", () => {
  it("notify nobody, as a newer relay may send ones this build doesn't know", async () => {
    const calls: string[] = [];
    const dispatcher = {
      dispatch: async () => void calls.push("dispatch"),
    } as unknown as Dispatcher;
    const policy = {
      suppress: async () => void calls.push("suppress"),
    } as unknown as DeliveryPolicy;
    const processor = new EventsProcessor(dispatcher, policy);
    await processor.process(job("todo.created.v1", { todoId: randomUUID(), title: "Hi" }));
    expect(calls).toEqual([]);
    // The same processor does act on one it's routed.
    await processor.process(
      job("webhook.endpoint_created.v1", { endpointId: randomUUID(), url: "https://x.test/h" }),
    );
    expect(calls).toEqual(["dispatch"]);
  });
});
