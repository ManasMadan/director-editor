/**
 * The fake's contract with Stripe: the calls apps/api makes (src/modules/billing), with
 * the parameters it sends, answer with the fields it reads, in the same shape, from the
 * fake and from Stripe itself. Against the fake on every run; against Stripe's test mode
 * too when STRIPE_CONTRACT_SECRET_KEY holds a test key (`sk_test_…`), which the weekly
 * Stripe workflow (.github/workflows/stripe.yml) sets. Each run there makes a customer, a
 * subscription in its free trial (nothing is charged) and deletes the customer after.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeStripe, startFakeStripe } from "./index";

/** What a target needs to run the calls: a client, a seat price, and a way to subscribe. */
interface Target {
  stripe: Stripe;
  price: string;
  /** A subscription for the customer, the way the app gets one (paid Checkout, or a trial). */
  subscribe(customer: string, orgId: string, price: string): Promise<string>;
  close(): Promise<void>;
}

async function fake(): Promise<Target> {
  const receiver: Server = createServer((_request, response) => response.writeHead(200).end());
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const server: FakeStripe = await startFakeStripe({
    secretKey: "sk_test_contract",
    webhookSecret: "whsec_contract",
    webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/`,
    prices: { price_seat: { interval: "month", unitAmount: 1_000 } },
  });
  const stripe = new Stripe("sk_test_contract", {
    host: "127.0.0.1",
    port: server.port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  return {
    stripe,
    price: "price_seat",
    async subscribe(customer, orgId, price) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price, quantity: 2 }],
        subscription_data: { metadata: { orgId }, trial_period_days: 14 },
        success_url: "https://example.com/done",
      });
      await fetch(`${server.url}/checkout/${session.id}/pay`, {
        method: "POST",
        redirect: "manual",
      });
      return server.subscriptionFor(orgId)?.id as string;
    },
    async close() {
      await server.close();
      await new Promise((resolve) => receiver.close(resolve));
    },
  };
}

/** Stripe's test mode: a seat price kept under a lookup key, so runs don't pile them up. */
async function real(key: string): Promise<Target> {
  const stripe = new Stripe(key);
  const lookup = "boilerplate-contract-seat";
  const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
  const price =
    existing.data[0]?.id ??
    (
      await stripe.prices.create({
        currency: "usd",
        unit_amount: 1_000,
        recurring: { interval: "month" },
        lookup_key: lookup,
        product_data: { name: "Contract test seat" },
      })
    ).id;
  const customers: string[] = [];
  return {
    stripe,
    price,
    // Checkout needs a browser; a trial needs no card, and the app's subscriptions start
    // in one too.
    async subscribe(customer, orgId, seatPrice) {
      customers.push(customer);
      const subscription = await stripe.subscriptions.create({
        customer,
        items: [{ price: seatPrice, quantity: 2 }],
        metadata: { orgId },
        trial_period_days: 14,
      });
      return subscription.id;
    },
    async close() {
      for (const customer of customers) {
        await stripe.customers.del(customer);
      }
    },
  };
}

const key = process.env.STRIPE_CONTRACT_SECRET_KEY;
const targets: [string, () => Promise<Target>][] = [["the fake", fake]];
if (key) {
  if (!key.startsWith("sk_test_")) {
    throw new Error("STRIPE_CONTRACT_SECRET_KEY must be a test key");
  }
  targets.push(["Stripe's test mode", () => real(key)]);
}

describe.each(targets)("%s", (_name, start) => {
  let target: Target;
  let customer: string;
  let subscription: string;
  const orgId = randomUUID();

  beforeAll(async () => {
    target = await start();
  }, 60_000);
  afterAll(async () => {
    await target?.close();
  }, 60_000);

  it("creates a customer once per organization", async () => {
    const params = { name: "Contract test", metadata: { orgId } };
    const options = { idempotencyKey: `customer-${orgId}` };
    const created = await target.stripe.customers.create(params, options);
    expect(created.id).toMatch(/^cus_/);
    expect(created.metadata.orgId).toBe(orgId);
    // A retried request is the same customer.
    expect((await target.stripe.customers.create(params, options)).id).toBe(created.id);
    customer = created.id;
  });

  it("opens a hosted Checkout with the app's parameters, and expires it once", async () => {
    const session = await target.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer,
        client_reference_id: orgId,
        line_items: [{ price: target.price, quantity: 2 }],
        subscription_data: { metadata: { orgId }, trial_period_days: 14 },
        allow_promotion_codes: true,
        success_url: "https://example.com/settings/billing?checkout=done",
        cancel_url: "https://example.com/settings/billing",
      },
      { idempotencyKey: `checkout-${orgId}-month-0` },
    );
    expect(session.id).toMatch(/^cs_/);
    expect(typeof session.url).toBe("string");
    expect((await target.stripe.checkout.sessions.expire(session.id)).status).toBe("expired");
    // The app logs this and carries on.
    await expect(target.stripe.checkout.sessions.expire(session.id)).rejects.toBeInstanceOf(
      Stripe.errors.StripeInvalidRequestError,
    );
  });

  it("answers a subscription with what the app mirrors", async () => {
    subscription = await target.subscribe(customer, orgId, target.price);
    const found = await target.stripe.subscriptions.retrieve(subscription);
    expect(found.metadata.orgId).toBe(orgId);
    expect(["trialing", "active"]).toContain(found.status);
    expect(found.cancel_at_period_end).toBe(false);
    expect(found.trial_end === null || typeof found.trial_end === "number").toBe(true);
    const item = found.items.data[0];
    expect(item?.price.id).toBe(target.price);
    expect(item?.quantity).toBe(2);
    expect(typeof item?.current_period_end).toBe("number");
  });

  it("changes the seats on the subscription's item", async () => {
    const before = await target.stripe.subscriptions.retrieve(subscription);
    const item = before.items.data[0]?.id as string;
    await target.stripe.subscriptions.update(
      subscription,
      { items: [{ id: item, quantity: 3 }], proration_behavior: "create_prorations" },
      { idempotencyKey: `seats-${subscription}-3-2` },
    );
    const after = await target.stripe.subscriptions.retrieve(subscription);
    expect(after.items.data[0]?.quantity).toBe(3);
  });

  it("lists invoices with the fields the billing page shows", async () => {
    const list = await target.stripe.invoices.list({ customer, limit: 24 });
    expect(Array.isArray(list.data)).toBe(true);
    for (const invoice of list.data) {
      expect(typeof invoice.id).toBe("string");
      expect(["draft", "open", "paid", "uncollectible", "void"]).toContain(invoice.status);
      expect(typeof invoice.amount_due).toBe("number");
      expect(typeof invoice.currency).toBe("string");
      expect(typeof invoice.created).toBe("number");
      expect(invoice).toHaveProperty("hosted_invoice_url");
      expect(invoice).toHaveProperty("number");
    }
  });

  it("opens the billing portal for the customer", async () => {
    const portal = await target.stripe.billingPortal.sessions.create({
      customer,
      return_url: "https://example.com/settings/billing",
    });
    expect(typeof portal.url).toBe("string");
  });

  it("cancels the subscription when the organization goes", async () => {
    const canceled = await target.stripe.subscriptions.cancel(
      subscription,
      {},
      { idempotencyKey: `cancel-${subscription}` },
    );
    expect(canceled.status).toBe("canceled");
  });
});
