/**
 * The fake speaks Stripe's API to the real SDK, keeps state between calls, serves the
 * hosted pages and signs its webhooks as Stripe does. Everything runs on loopback: the
 * fake, and a receiver standing in for apps/webhooks.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeStripe, startFakeStripe } from "./index";

const SECRET_KEY = "sk_test_fake";
const WEBHOOK_SECRET = "whsec_fake";
const MONTHLY = "price_monthly";
const YEARLY = "price_yearly";

let fake: FakeStripe;
let stripe: Stripe;
let receiver: Server;
/** Verified events the receiver got, and whether it accepts the next ones. */
const received: Stripe.Event[] = [];
let refuse = false;

beforeAll(async () => {
  receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    if (refuse) {
      response.writeHead(503).end();
      return;
    }
    received.push(
      await Stripe.webhooks.constructEventAsync(
        Buffer.concat(chunks),
        String(request.headers["stripe-signature"]),
        WEBHOOK_SECRET,
      ),
    );
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  fake = await startFakeStripe({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/`,
    prices: {
      [MONTHLY]: { interval: "month", unitAmount: 1_200 },
      [YEARLY]: { interval: "year", unitAmount: 12_000 },
    },
  });
  stripe = client(SECRET_KEY);
});
afterAll(async () => {
  await fake?.close();
  await new Promise((resolve) => receiver?.close(resolve));
});
beforeEach(() => {
  refuse = false;
});

function client(key: string) {
  return new Stripe(key, {
    host: "127.0.0.1",
    port: fake.port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
}

const get = (path: string) => fetch(`${fake.url}${path}`, { redirect: "manual" });
const post = (path: string, form: Record<string, string> = {}) =>
  fetch(`${fake.url}${path}`, {
    method: "POST",
    body: new URLSearchParams(form),
    redirect: "manual",
  });
const types = () => received.map((event) => event.type);

/** A customer with an open Checkout session for `price`. */
async function checkout(params: Partial<Stripe.Checkout.SessionCreateParams> = {}) {
  const customer = await stripe.customers.create({ metadata: { orgId: "org_1" } });
  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    mode: "subscription",
    line_items: [{ price: MONTHLY, quantity: 2 }],
    success_url: "http://app.test/billing?session={CHECKOUT_SESSION_ID}",
    cancel_url: "http://app.test/billing",
    ...params,
  });
  return { customer, session };
}

async function pay(sessionId: string) {
  const response = await post(`/checkout/${sessionId}/pay`);
  expect(response.status).toBe(303);
  return response.headers.get("location");
}

describe("the API", () => {
  it("refuses a wrong secret key", async () => {
    await expect(client("sk_test_wrong").customers.create()).rejects.toMatchObject({
      statusCode: 401,
      message: "Invalid API Key",
    });
  });

  it("answers 404 to a call it doesn't implement", async () => {
    await expect(stripe.products.list()).rejects.toMatchObject({
      statusCode: 404,
      message: "Unrecognized request URL",
    });
  });

  it("replays a POST with the same idempotency key, and never a GET", async () => {
    const first = await stripe.customers.create({}, { idempotencyKey: "same" });
    const again = await stripe.customers.create({}, { idempotencyKey: "same" });
    expect(again.id).toBe(first.id);
    expect(first.metadata).toEqual({});
    const list = () =>
      fetch(`${fake.url}/v1/subscriptions?customer=${first.id}`, {
        headers: { authorization: `Bearer ${SECRET_KEY}`, "idempotency-key": "read" },
      }).then((response) => response.json());
    expect(await list()).toEqual({ object: "list", data: [], has_more: false });
    expect(await list()).toEqual({ object: "list", data: [], has_more: false });
  });

  it("refuses an idempotency key reused for a different request", async () => {
    await stripe.customers.create({ name: "A" }, { idempotencyKey: "one-request" });
    await expect(
      stripe.customers.create({ name: "B" }, { idempotencyKey: "one-request" }),
    ).rejects.toMatchObject({ statusCode: 400, type: "StripeIdempotencyError" });
  });

  it("reads a Checkout session back, and 404s an unknown one", async () => {
    const { session } = await checkout();
    expect(await stripe.checkout.sessions.retrieve(session.id)).toMatchObject({
      id: session.id,
      status: "open",
      url: session.url,
    });
    await expect(stripe.checkout.sessions.retrieve("cs_missing")).rejects.toMatchObject({
      statusCode: 404,
      message: "No such checkout session",
    });
  });

  it("needs a known customer for Checkout and the portal", async () => {
    const missing = { customer: "cus_missing" };
    await expect(
      stripe.checkout.sessions.create({ ...missing, mode: "subscription" }),
    ).rejects.toMatchObject({ statusCode: 404, message: "No such customer" });
    await expect(stripe.billingPortal.sessions.create(missing)).rejects.toMatchObject({
      statusCode: 404,
      message: "No such customer",
    });
  });

  it("expires an open Checkout session only", async () => {
    const { session } = await checkout();
    expect((await stripe.checkout.sessions.expire(session.id)).status).toBe("expired");
    await expect(stripe.checkout.sessions.expire(session.id)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(stripe.checkout.sessions.expire("cs_missing")).rejects.toMatchObject({
      statusCode: 404,
      message: "No such checkout session",
    });
    expect((await get(`/checkout/${session.id}`)).status).toBe(410);
  });

  it("reads, changes and cancels a subscription, with an event for each change", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const [subscription] = (await stripe.subscriptions.list({ customer: customer.id })).data;
    if (!subscription) {
      throw new Error("no subscription");
    }
    expect(subscription).toMatchObject({ status: "active", metadata: {}, trial_end: null });
    const item = subscription.items.data[0] as Stripe.SubscriptionItem;
    expect(item).toMatchObject({ quantity: 2, price: { unit_amount: 1_200 } });
    expect((await stripe.subscriptions.retrieve(subscription.id)).id).toBe(subscription.id);

    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, quantity: 5 }],
      cancel_at_period_end: true,
    });
    expect(updated.items.data[0]?.quantity).toBe(5);
    expect(updated.cancel_at_period_end).toBe(true);
    // An item without a new quantity, and no change to the cancellation, keep both.
    const unchanged = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id }],
    });
    expect(unchanged).toMatchObject({ cancel_at_period_end: true });
    expect(unchanged.items.data[0]?.quantity).toBe(5);
    expect(
      (await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: false }))
        .cancel_at_period_end,
    ).toBe(false);
    await expect(
      stripe.subscriptions.update(subscription.id, { items: [{ id: "si_missing" }] }),
    ).rejects.toMatchObject({ statusCode: 404, message: "No such subscription item" });

    const canceled = await stripe.subscriptions.cancel(subscription.id);
    expect(canceled.status).toBe("canceled");
    expect(types().slice(-4)).toEqual([
      "customer.subscription.updated",
      "customer.subscription.updated",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]);
    await expect(stripe.subscriptions.retrieve("sub_missing")).rejects.toMatchObject({
      statusCode: 404,
      message: "No such subscription",
    });
  });

  it("answers 404 to a method a subscription doesn't have", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const subscription = (await stripe.subscriptions.list({ customer: customer.id })).data[0];
    const response = await fetch(`${fake.url}/v1/subscriptions/${subscription?.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    });
    expect(response.status).toBe(404);
  });

  it("lists a customer's invoices, newest first, as many as asked", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const subscription = (await stripe.subscriptions.list({ customer: customer.id })).data[0];
    await post(`/__fake/subscriptions/${subscription?.id}/payment-failed`);
    const all = await stripe.invoices.list({ customer: customer.id });
    expect(all.data.map((invoice) => [invoice.status, invoice.amount_due])).toEqual([
      ["open", 2_400],
      ["paid", 2_400],
    ]);
    const unlimited = await fetch(`${fake.url}/v1/invoices?customer=${customer.id}`, {
      headers: { authorization: `Bearer ${SECRET_KEY}` },
    }).then((response) => response.json() as Promise<{ data: unknown[] }>);
    expect(unlimited.data).toHaveLength(2);
    expect((await stripe.invoices.list({ customer: customer.id, limit: 1 })).data).toHaveLength(1);
  });

  it("answers 500 when apps/webhooks refuses an event", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const subscription = (await stripe.subscriptions.list({ customer: customer.id })).data[0];
    refuse = true;
    await expect(stripe.subscriptions.cancel(subscription?.id as string)).rejects.toMatchObject({
      statusCode: 500,
      message: "webhook customer.subscription.deleted was refused: 503",
    });
  });
});

describe("Checkout", () => {
  it("shows the plan, then subscribes with a trial and sends the events", async () => {
    const { session } = await checkout({
      line_items: [{ price: YEARLY, quantity: 1 }],
      subscription_data: { trial_period_days: 14, metadata: { orgId: "org_trial" } },
    });
    const page = await (await get(`/checkout/${session.id}`)).text();
    expect(page).toContain("1 × 120.00 USD / year");
    expect(page).toContain('href="http://app.test/billing"');

    expect(await pay(session.id)).toBe(`http://app.test/billing?session=${session.id}`);
    const subscription = fake.subscriptionFor("org_trial");
    expect(subscription).toMatchObject({ status: "trialing", trial_end: expect.any(Number) });
    const { data } = await stripe.invoices.list({ customer: subscription?.customer as string });
    expect(data[0]?.amount_due).toBe(0);
    expect(types().slice(-2)).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
    ]);
    // Paying again only sends the browser back.
    expect(await pay(session.id)).toBe("http://app.test/billing?session={CHECKOUT_SESSION_ID}");
  });

  it("records the card paid with: the same card has the same fingerprint", async () => {
    const card = async (form: Record<string, string>) => {
      const { customer, session } = await checkout();
      expect((await post(`/checkout/${session.id}/pay`, form)).status).toBe(303);
      const [subscription] = (await stripe.subscriptions.list({ customer: customer.id })).data;
      return stripe.paymentMethods.retrieve(subscription?.default_payment_method as string);
    };
    const first = await card({});
    expect(first).toMatchObject({ type: "card", card: { fingerprint: "fp_4242", last4: "4242" } });
    expect((await card({})).card?.fingerprint).toBe("fp_4242");
    expect((await card({ card: "5555555555554444" })).card).toMatchObject({
      fingerprint: "fp_5555555555554444",
      last4: "4444",
    });
    const sepa = await card({ method: "sepa_debit" });
    expect(sepa).toMatchObject({ type: "sepa_debit" });
    expect(sepa.card).toBeUndefined();
    await expect(stripe.paymentMethods.retrieve("pm_missing")).rejects.toMatchObject({
      statusCode: 404,
      message: "No such payment method",
    });
  });

  it("takes no card for a trial that doesn't require one", async () => {
    const { customer, session } = await checkout({
      payment_method_collection: "if_required",
      subscription_data: { trial_period_days: 14 },
    });
    await pay(session.id);
    const [subscription] = (await stripe.subscriptions.list({ customer: customer.id })).data;
    expect(subscription).toMatchObject({ status: "trialing", default_payment_method: null });
    // Without a trial there's something to pay, so it takes the card.
    const paid = await checkout({ payment_method_collection: "if_required" });
    await pay(paid.session.id);
    const [charged] = (await stripe.subscriptions.list({ customer: paid.customer.id })).data;
    expect(charged?.default_payment_method).toMatch(/^pm_/);
  });

  it("ends a trial now: the plan is active and the card is charged", async () => {
    const { customer, session } = await checkout({
      subscription_data: { trial_period_days: 14 },
    });
    await pay(session.id);
    const [trial] = (await stripe.subscriptions.list({ customer: customer.id })).data;
    const ended = await stripe.subscriptions.update(trial?.id as string, { trial_end: "now" });
    expect(ended.status).toBe("active");
    expect(ended.trial_end).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    const { data } = await stripe.invoices.list({ customer: customer.id });
    expect(data.map((invoice) => invoice.amount_due)).toEqual([2_400, 0]);
    expect(types().at(-1)).toBe("customer.subscription.updated");
    // Only a trial can end: an active plan is left as it is.
    const again = await stripe.subscriptions.update(ended.id, { trial_end: "now" });
    expect(again.trial_end).toBe(ended.trial_end);
    expect((await stripe.invoices.list({ customer: customer.id })).data).toHaveLength(2);
  });

  it("declines a declined card and lets the customer try again", async () => {
    const { customer, session } = await checkout({ line_items: [{ price: MONTHLY }] });
    const response = await post(`/checkout/${session.id}/pay`, { card: "declined" });
    expect(response.status).toBe(402);
    expect(await response.text()).toContain(`href="/checkout/${session.id}"`);
    await pay(session.id);
    const { data } = await stripe.subscriptions.list({ customer: customer.id });
    expect(data[0]?.items.data[0]?.quantity).toBe(1);
  });

  it("fails loudly on a price the app didn't configure", async () => {
    const { session } = await checkout({ line_items: [{ price: "price_unknown" }] });
    const page = await (await get(`/checkout/${session.id}`)).text();
    expect(page).toContain("1 × 0.00 USD / undefined");
    const response = await post(`/checkout/${session.id}/pay`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { message: "unknown price price_unknown" },
    });
  });

  it("shows a session without a first line", async () => {
    const customer = await stripe.customers.create();
    const response = await fetch(`${fake.url}/v1/checkout/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET_KEY}` },
      body: new URLSearchParams({
        customer: customer.id,
        "line_items[1][price]": MONTHLY,
        cancel_url: "http://app.test/billing",
      }),
    });
    const { id } = (await response.json()) as { id: string };
    expect(await (await get(`/checkout/${id}`)).text()).toContain("1 × 0.00 USD");
  });

  it("answers 404 for an unknown session or page", async () => {
    expect((await get("/checkout/cs_missing")).status).toBe(404);
    expect((await get("/elsewhere")).status).toBe(404);
  });
});

describe("the billing portal", () => {
  it("cancels and resumes the plan, then returns", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "http://app.test/billing",
    });
    const path = new URL(portal.url).pathname;
    expect(await (await get(path)).text()).toContain("Plan: active</p>");

    expect((await post(`${path}/cancel`)).headers.get("location")).toBe(path);
    const canceling = await (await get(path)).text();
    expect(canceling).toContain("Plan: active, cancels at the end of the period");
    expect(canceling).toContain("Resume plan");
    expect(canceling).toContain('href="http://app.test/billing"');

    await post(`${path}/resume`);
    expect(await (await get(path)).text()).toContain("Cancel plan");
    expect(types().slice(-2)).toEqual([
      "customer.subscription.updated",
      "customer.subscription.updated",
    ]);
  });

  it("shows a customer without a plan that there's nothing to change", async () => {
    const customer = await stripe.customers.create();
    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "http://app.test/billing",
    });
    const path = new URL(portal.url).pathname;
    const response = await post(`${path}/cancel`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No subscription.");
    expect((await get("/portal/bps_missing")).status).toBe(404);
  });
});

describe("test hooks", () => {
  it("make a renewal fail, or a subscription lapse", async () => {
    const { customer, session } = await checkout();
    await pay(session.id);
    const subscription = (await stripe.subscriptions.list({ customer: customer.id })).data[0];

    const failed = await post(`/__fake/subscriptions/${subscription?.id}/payment-failed`);
    expect(await failed.json()).toMatchObject({ status: "past_due" });
    expect(types().slice(-2)).toEqual(["invoice.payment_failed", "customer.subscription.updated"]);

    const events = fake.events.length;
    await post(`/__fake/subscriptions/${subscription?.id}/invoice?status=draft`);
    expect(fake.events.length).toBe(events);
    const [draft] = (await stripe.invoices.list({ customer: customer.id, limit: 1 })).data;
    expect(draft).toMatchObject({ status: "draft", number: null, hosted_invoice_url: null });

    const lapsed = await post(`/__fake/subscriptions/${subscription?.id}/lapse`);
    expect(await lapsed.json()).toMatchObject({ status: "canceled" });
    expect(types().at(-1)).toBe("customer.subscription.deleted");

    const state = (await (await get("/__fake/state")).json()) as { events: unknown[] };
    expect(state.events.length).toBe(fake.events.length);
  });

  it("answer 404 for an unknown subscription or hook", async () => {
    expect((await post("/__fake/subscriptions/sub_missing/lapse")).status).toBe(404);
    expect((await post("/__fake/other")).status).toBe(404);
  });
});

describe("the port", () => {
  it("is the one asked for", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const pinned = await startFakeStripe({
      secretKey: SECRET_KEY,
      webhookSecret: WEBHOOK_SECRET,
      webhookUrl: "http://127.0.0.1:1/",
      prices: {},
      port,
    });
    try {
      expect(pinned.url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await pinned.close();
    }
  });
});
