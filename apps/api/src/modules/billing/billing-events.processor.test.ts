import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import type { BillingService } from "./billing.service";
import { BillingEventsProcessor } from "./billing-events.processor";

function failedPayment(invoice: Record<string, unknown>) {
  return eventJob("stripe.event_received.v1", {
    inboundEventId: randomUUID(),
    stripeEventId: "evt_1",
    type: "invoice.payment_failed",
    object: { parent: { subscription_details: { subscription: "sub_1" } }, ...invoice },
  });
}

function eventJob(name: string, payload: unknown) {
  return {
    data: {
      meta: {},
      payload: {
        id: randomUUID(),
        name,
        key: "evt_1",
        payload,
        orgId: null,
        actorId: null,
        requestId: null,
        occurredAt: new Date().toISOString(),
        source: "webhooks",
      },
    },
  } as unknown as Job;
}

function processor() {
  const billing = {
    enabled: true,
    sync: vi.fn(async () => undefined),
    syncSeats: vi.fn(async () => undefined),
    orgFor: vi.fn(async () => ({ id: randomUUID(), name: "Acme" })),
  } as unknown as BillingService;
  const notifications = { add: vi.fn(async () => undefined) };
  return {
    processor: new BillingEventsProcessor(billing, notifications as never),
    billing,
    notifications,
  };
}

describe("a failed payment's alert", () => {
  it("names the amount and currency the invoice has", async () => {
    const { processor: events, notifications } = processor();
    await events.process(failedPayment({ amount_due: 1_200, currency: "eur" }));
    expect(notifications.add).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        data: expect.objectContaining({ amount: 1_200, currency: "EUR" }),
      }),
      expect.anything(),
    );
  });

  it("fails loudly, rather than send one for 0 USD, when the invoice has neither", async () => {
    const { processor: events, notifications } = processor();
    await expect(events.process(failedPayment({}))).rejects.toThrow();
    expect(notifications.add).not.toHaveBeenCalled();
  });
});

describe("events billing isn't routed", () => {
  it("ignores them, as a newer relay may send ones this build doesn't know", async () => {
    const { processor: events, billing, notifications } = processor();
    await events.process(eventJob("todo.created.v1", { todoId: randomUUID(), title: "Hi" }));
    expect(billing.syncSeats).not.toHaveBeenCalled();
    expect(billing.sync).not.toHaveBeenCalled();
    expect(notifications.add).not.toHaveBeenCalled();
  });
});
