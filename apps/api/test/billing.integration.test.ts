/**
 * Billing against a stateful fake Stripe (packages/fake-stripe). Its webhooks are received
 * here the way apps/webhooks and the relay would pass them on: verified, then queued as
 * `stripe.event_received.v1` for the billing consumer running in this API. Membership
 * events are relayed from the outbox the same way. (A separate file: billing must be on.)
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import { type OrgId, orgIdSchema } from "@repo/contracts/ids";
import { type FakeStripe, startFakeStripe } from "@repo/fake-stripe";
import { createProducer, queuePrefix } from "@repo/jobs";
import { eventually } from "@repo/testing/eventually";
import { type Job, Queue } from "bullmq";
import pg from "pg";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSession,
  type Harness,
  newEmail,
  newPassword,
  startApi,
  takeNotification,
  takeOtp,
} from "./harness";

const SECRET_KEY = `sk_test_${randomUUID().replaceAll("-", "")}`;
const WEBHOOK_SECRET = `whsec_${randomUUID().replaceAll("-", "")}`;
const MONTHLY = "price_pro_monthly_test";
const YEARLY = "price_pro_yearly_test";
/** A price in the same Stripe account that isn't one of the app's plans. */
const OTHER = "price_other_product_test";

let harness: Harness;
let stripe: FakeStripe;
let receiver: Server;
let events: ReturnType<typeof createProducer<"events-billing">>;
/** Every Stripe event the receiver passed on, in order. */
const forwarded: Job[] = [];

beforeAll(async () => {
  // Stands in for apps/webhooks + the outbox relay: verify, then queue for billing.
  receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const event = await Stripe.webhooks.constructEventAsync(
      Buffer.concat(chunks),
      String(request.headers["stripe-signature"]),
      WEBHOOK_SECRET,
    );
    forwarded.push(
      await queueEvent("stripe.event_received.v1", event.id, {
        inboundEventId: randomUUID(),
        stripeEventId: event.id,
        type: event.type,
        object: event.data.object as unknown as Record<string, unknown>,
      }),
    );
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  stripe = await startFakeStripe({
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/`,
    prices: {
      [MONTHLY]: { interval: "month", unitAmount: 1_200 },
      [YEARLY]: { interval: "year", unitAmount: 12_000 },
      [OTHER]: { interval: "month", unitAmount: 500 },
    },
  });
  harness = await startApi(10, {
    STRIPE_SECRET_KEY: SECRET_KEY,
    STRIPE_PRICE_PRO_MONTHLY: MONTHLY,
    STRIPE_PRICE_PRO_YEARLY: YEARLY,
    STRIPE_API_URL: stripe.url,
    STRIPE_TRIAL_DAYS: "14",
  });
  events = createProducer("events-billing", harness.redis);
});

afterAll(async () => {
  await events?.close();
  await harness?.close();
  await stripe?.close();
  await new Promise((resolve) => receiver?.close(resolve));
});

async function queueEvent(name: string, key: string, payload: unknown, orgId: OrgId | null = null) {
  const id = randomUUID();
  return events.add(
    "event",
    {
      id,
      name,
      key,
      payload,
      orgId,
      actorId: null,
      requestId: null,
      occurredAt: new Date().toISOString(),
      source: "webhooks",
    },
    { jobId: id },
  );
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: harness.testDb.urlFor("postgres") });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** What the relay does for membership changes: pass the outbox's events to billing. */
async function relayMembership(orgId: OrgId) {
  const rows = await sql<{ id: string; name: string; key: string; payload: unknown }>(
    `SELECT id, name, key, payload FROM app.outbox_event
     WHERE org_id = $1 AND name IN ('org.member_added.v1', 'org.member_removed.v1')`,
    [orgId],
  );
  const jobs: Job[] = [];
  for (const row of rows) {
    jobs.push(await queueEvent(row.name, row.key, row.payload, orgId));
  }
  return jobs;
}

/** Waits until the billing consumer has handled these events; how each one ended. */
async function settled(jobs: Job[]) {
  const states = () => Promise.all(jobs.map((job) => job.getState()));
  return eventually(states, (all) =>
    all.every((state) => state === "completed" || state === "failed"),
  );
}

/** What the receiver forwards while `work` runs, once the billing consumer is done with it. */
async function handled(work: () => Promise<unknown>) {
  const from = forwarded.length;
  await work();
  return settled(forwarded.slice(from));
}

/** Stripe's API itself (the fake), as something other than this app would call it. */
const sdk = () =>
  new Stripe(SECRET_KEY, { host: "127.0.0.1", port: stripe.port, protocol: "http" });

/** A subscription paid for through Checkout, made outside the app. */
async function outsideSubscription(
  { price = MONTHLY, metadata }: { price?: string; metadata?: Record<string, string> } = {},
  customer?: string,
) {
  const client = sdk();
  const customerId = customer ?? (await client.customers.create()).id;
  const session = await client.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    success_url: "http://elsewhere.test/done",
    cancel_url: "http://elsewhere.test/",
    ...(metadata && { subscription_data: { metadata } }),
  });
  await fetch(`${stripe.url}/checkout/${session.id}/pay`, { method: "POST", redirect: "manual" });
  const [subscription] = (await client.subscriptions.list({ customer: customerId })).data.slice(-1);
  return subscription as Stripe.Subscription;
}

async function signedIn() {
  const session = createSession(harness);
  const email = newEmail();
  await session.auth("/sign-up/email", { email, password: newPassword(), name: "Billing" });
  const { otp } = await takeOtp(harness, email);
  await session.auth("/email-otp/verify-email", { email, otp });
  return { session, email };
}

/** A shared workspace, active for its owner. */
async function workspace() {
  const owner = await signedIn();
  const org = await owner.session.auth<{ id: string }>("/organization/create", {
    name: "Acme",
    slug: `acme-${randomUUID().slice(0, 8)}`,
  });
  await owner.session.auth("/organization/set-active", { organizationId: org.body.id });
  return { owner, orgId: orgIdSchema.parse(org.body.id) };
}

async function invite(session: ReturnType<typeof createSession>, orgId: string, email: string) {
  return session.auth<{ code?: string }>("/organization/invite-member", {
    email,
    role: "member",
    organizationId: orgId,
  });
}

async function join(owner: ReturnType<typeof createSession>, orgId: string, role = "member") {
  const member = await signedIn();
  await owner.auth("/organization/invite-member", {
    email: member.email,
    role,
    organizationId: orgId,
  });
  const invitation = await takeNotification(harness, "org.invitation", member.email);
  const invitationId = new URL(invitation.data.acceptUrl).pathname.split("/").at(-1);
  await member.session.auth("/organization/accept-invitation", { invitationId });
  await member.session.auth("/organization/set-active", { organizationId: orgId });
  return member;
}

/**
 * Subscribes through the fake Stripe's hosted checkout, as a browser would, with a card
 * of its own unless given one (a card has one free trial, in any workspace).
 */
async function subscribe(
  session: ReturnType<typeof createSession>,
  interval: "month" | "year" = "month",
  card: string = randomUUID(),
) {
  const { url } = await session.rpc.billing.checkout({ interval });
  expect(url).toMatch(new RegExp(`^${stripe.url}/checkout/cs_`));
  const paid = await pay(url, card);
  expect(paid.status).toBe(303);
  expect(paid.headers.get("location")).toContain("/settings/billing?checkout=done");
  return eventually(
    () => session.rpc.billing.overview(),
    (overview) => overview.plan === "pro",
  );
}

/** Pays on the fake's hosted checkout page with `card`; the page's answer. */
const pay = (url: string, card: string = randomUUID()) =>
  fetch(`${url}/pay`, { method: "POST", body: new URLSearchParams({ card }), redirect: "manual" });

async function expectError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(ORPCError);
  expect((error as ORPCError<string, unknown>).code).toBe(code);
  return error as ORPCError<string, { params?: unknown }>;
}

describe("plans and entitlements", () => {
  it("starts on Free: three members and no webhooks", async () => {
    const { owner } = await workspace();
    expect(await owner.session.rpc.billing.overview()).toEqual({
      enabled: true,
      plan: "free",
      entitlements: { members: 3, webhooks: false },
      members: 1,
      subscription: null,
    });
    expect((await owner.session.rpc.system.info()).features.billing).toBe(true);
    const error = await expectError(
      owner.session.rpc.webhooks.createEndpoint({ url: "https://example.com/hook" }),
      "ENTITLEMENT_REQUIRED",
    );
    expect(error.data?.params).toEqual({ entitlement: "webhooks" });
  });

  it("counts pending invitations towards the member limit", async () => {
    const { owner, orgId } = await workspace();
    expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    const refused = await invite(owner.session, orgId, newEmail());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ENTITLEMENT_REQUIRED");
  });

  it("only owners and admins see or change billing", async () => {
    const { owner, orgId } = await workspace();
    const member = await join(owner.session, orgId);
    await expectError(member.session.rpc.billing.overview(), "FORBIDDEN");
    await expectError(member.session.rpc.billing.checkout({ interval: "month" }), "FORBIDDEN");
    await expectError(member.session.rpc.billing.portal(), "FORBIDDEN");
  });
});

describe("subscribing", () => {
  it("checkout starts a trial on Pro, per seat, and unlocks the plan", async () => {
    const { owner, orgId } = await workspace();
    await join(owner.session, orgId);
    const overview = await subscribe(owner.session);
    expect(overview).toMatchObject({
      plan: "pro",
      entitlements: { members: null, webhooks: true },
      members: 2,
      subscription: {
        status: "trialing",
        interval: "month",
        seats: 2,
        cancelAtPeriodEnd: false,
        trialEnd: expect.any(Date),
      },
    });
    const days = ((overview.subscription?.trialEnd?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(14);
    await expect(
      owner.session.rpc.webhooks.createEndpoint({ url: "https://example.com/hook" }),
    ).resolves.toMatchObject({ endpoint: { url: "https://example.com/hook" } });
    for (let i = 0; i < 3; i++) {
      expect((await invite(owner.session, orgId, newEmail())).status).toBe(200);
    }
    // The subscription is tied to the workspace in Stripe.
    expect(stripe.subscriptionFor(orgId)?.metadata).toEqual({ orgId });
  });

  it("keeps one checkout open per workspace, so it can't pay twice", async () => {
    const { owner, orgId } = await workspace();
    // A double click, or two tabs: the same session.
    const [first, again] = await Promise.all([
      owner.session.rpc.billing.checkout({ interval: "month" }),
      owner.session.rpc.billing.checkout({ interval: "month" }),
    ]);
    expect(again.url).toBe(first.url);
    // Or a click later on, while that session is still open.
    expect((await owner.session.rpc.billing.checkout({ interval: "month" })).url).toBe(first.url);
    const customers = [...stripe.customers.values()].filter((c) => c.metadata.orgId === orgId);
    expect(customers).toHaveLength(1);
    expect(
      await sql("SELECT stripe_customer_id FROM billing.customer WHERE org_id = $1", [orgId]),
    ).toEqual([{ stripe_customer_id: customers[0]?.id }]);

    // Changing one's mind: the new session closes the old one.
    const yearly = await owner.session.rpc.billing.checkout({ interval: "year" });
    expect(yearly.url).not.toBe(first.url);
    expect((await fetch(`${first.url}/pay`, { method: "POST", redirect: "manual" })).status).toBe(
      410,
    );

    await fetch(`${yearly.url}/pay`, { method: "POST", redirect: "manual" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.plan === "pro",
    );
    await expectError(
      owner.session.rpc.billing.checkout({ interval: "year" }),
      "ALREADY_SUBSCRIBED",
    );
    expect(
      [...stripe.subscriptions.values()].filter((s) => s.metadata.orgId === orgId),
    ).toHaveLength(1);
  });

  it("opens a new checkout when the seats change, and closes the old one", async () => {
    const { owner, orgId } = await workspace();
    const alone = await owner.session.rpc.billing.checkout({ interval: "month" });
    await join(owner.session, orgId);
    // The same interval within the hour, for two seats now: a new session, not a replay.
    const two = await owner.session.rpc.billing.checkout({ interval: "month" });
    expect(two.url).not.toBe(alone.url);
    expect(await (await fetch(two.url)).text()).toContain("2 × 12.00 USD / month");
    expect((await pay(alone.url)).status).toBe(410);
    expect((await pay(two.url)).status).toBe(303);
  });

  it("changing one's mind back and forth leaves the latest checkout payable", async () => {
    const { owner } = await workspace();
    const monthly = await owner.session.rpc.billing.checkout({ interval: "month" });
    const yearly = await owner.session.rpc.billing.checkout({ interval: "year" });
    const monthlyAgain = await owner.session.rpc.billing.checkout({ interval: "month" });
    expect(new Set([monthly.url, yearly.url, monthlyAgain.url]).size).toBe(3);
    expect((await pay(monthly.url)).status).toBe(410);
    expect((await pay(yearly.url)).status).toBe(410);
    expect((await pay(monthlyAgain.url)).status).toBe(303);
  });

  it("a declined card leaves the workspace on Free", async () => {
    const { owner } = await workspace();
    const { url } = await owner.session.rpc.billing.checkout({ interval: "month" });
    const from = forwarded.length;
    const declined = await fetch(`${url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "card=declined",
    });
    expect(declined.status).toBe(402);
    // Stripe sends no event for a declined card (the fake sends its events before it
    // answers), so nothing is left to change the plan.
    expect(forwarded.slice(from)).toEqual([]);
    expect((await owner.session.rpc.billing.overview()).plan).toBe("free");
  });

  it("gives one free trial per workspace", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    await fetch(`${stripe.url}/__fake/subscriptions/${subscription?.id}/lapse`, { method: "POST" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.plan === "free",
    );
    // The same interval again within the hour: a new checkout, not the one already paid.
    const again = await subscribe(owner.session, "month");
    expect(again.subscription).toMatchObject({
      status: "active",
      interval: "month",
      trialEnd: null,
    });
  });
});

describe("one free trial per card", () => {
  it("a new workspace paying with a card that had a trial is charged at once", async () => {
    const card = randomUUID();
    const first = await workspace();
    await subscribe(first.owner.session, "month", card);
    const second = await workspace();
    await subscribe(second.owner.session, "month", card);
    const ended = await eventually(
      () => second.owner.session.rpc.billing.overview(),
      (overview) => overview.subscription?.status === "active",
    );
    expect(ended.plan).toBe("pro");
    const { data } = await sdk().invoices.list({
      customer: stripe.subscriptionFor(second.orgId)?.customer as string,
    });
    expect(data[0]?.amount_due).toBe(1_200);

    // The first keeps its trial, however often it's synced again (a member joining).
    await join(first.owner.session, first.orgId);
    expect(await settled(await relayMembership(first.orgId))).not.toContain("failed");
    expect((await first.owner.session.rpc.billing.overview()).subscription).toMatchObject({
      status: "trialing",
      seats: 2,
    });
    // Another card is another trial.
    const third = await workspace();
    expect((await subscribe(third.owner.session)).subscription?.status).toBe("trialing");
  });

  it("a trial paid without a card keeps it", async () => {
    const { owner, orgId } = await workspace();
    const { url } = await owner.session.rpc.billing.checkout({ interval: "month" });
    const paid = await handled(() =>
      fetch(`${url}/pay`, {
        method: "POST",
        body: new URLSearchParams({ method: "sepa_debit" }),
        redirect: "manual",
      }),
    );
    expect(paid).not.toContain("failed");
    expect(await sql("SELECT status FROM billing.subscription WHERE org_id = $1", [orgId])).toEqual(
      [{ status: "trialing" }],
    );
  });

  it("a trial started without a card keeps it", async () => {
    const { orgId } = await workspace();
    const client = sdk();
    const customer = await client.customers.create({ metadata: { orgId } });
    const session = await client.checkout.sessions.create({
      customer: customer.id,
      mode: "subscription",
      payment_method_collection: "if_required",
      line_items: [{ price: MONTHLY, quantity: 1 }],
      subscription_data: { metadata: { orgId }, trial_period_days: 14 },
      success_url: "http://elsewhere.test/done",
    });
    expect(await handled(() => pay(`${stripe.url}/checkout/${session.id}`))).not.toContain(
      "failed",
    );
    expect(await sql("SELECT status FROM billing.subscription WHERE org_id = $1", [orgId])).toEqual(
      [{ status: "trialing" }],
    );
  });
});

describe("keeping in sync with Stripe", () => {
  it("bills per seat as members join and leave", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const member = await join(owner.session, orgId);
    await relayMembership(orgId);
    await eventually(
      async () => stripe.subscriptionFor(orgId)?.items.data[0]?.quantity,
      (quantity) => quantity === 2,
    );
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (overview) => overview.subscription?.seats === 2,
    );
    await owner.session.auth("/organization/remove-member", {
      memberIdOrEmail: member.email,
      organizationId: orgId,
    });
    await relayMembership(orgId);
    expect(
      await eventually(
        async () => stripe.subscriptionFor(orgId)?.items.data[0]?.quantity,
        (quantity) => quantity === 1,
      ),
    ).toBe(1);
  });

  it("a failed renewal keeps Pro while Stripe retries, and tells owners and admins", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    await fetch(`${stripe.url}/__fake/subscriptions/${subscription?.id}/payment-failed`, {
      method: "POST",
    });
    const overview = await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.status === "past_due",
    );
    expect(overview.plan).toBe("pro");

    const queue = new Queue("notifications-critical", {
      connection: harness.redis,
      prefix: queuePrefix("notifications-critical"),
    });
    const jobs = await eventually(
      async () =>
        (await queue.getJobs(["waiting", "delayed", "prioritized"])).filter(
          (job) =>
            job.data.payload.template === "billing.payment-failed" &&
            job.data.payload.to.orgId === orgId,
        ),
      (found) => found.length > 0,
    );
    await queue.close();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.payload).toMatchObject({
      to: { orgId, roles: ["owner", "admin"] },
      data: { organizationName: "Acme", amount: 1_200, currency: "USD" },
    });
  });

  it("the portal cancels at the end of the period; the plan lasts until then", async () => {
    const { owner } = await workspace();
    await subscribe(owner.session);
    const { url } = await owner.session.rpc.billing.portal();
    expect(url).toMatch(new RegExp(`^${stripe.url}/portal/bps_`));
    await fetch(`${url}/cancel`, { method: "POST", redirect: "manual" });
    const overview = await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === true,
    );
    expect(overview.plan).toBe("pro");
    await fetch(`${url}/resume`, { method: "POST", redirect: "manual" });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === false,
    );
  });

  it("an old event replayed late can't undo a newer change", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const subscription = stripe.subscriptionFor(orgId);
    const stale = structuredClone(subscription);
    await fetch(`${(await owner.session.rpc.billing.portal()).url}/cancel`, {
      method: "POST",
      redirect: "manual",
    });
    await eventually(
      () => owner.session.rpc.billing.overview(),
      (current) => current.subscription?.cancelAtPeriodEnd === true,
    );
    // The creation event arrives again, with the old state in it.
    const replayed = await queueEvent("stripe.event_received.v1", "evt_replayed", {
      inboundEventId: randomUUID(),
      stripeEventId: "evt_replayed",
      type: "customer.subscription.created",
      object: stale as unknown as Record<string, unknown>,
    });
    expect(await settled([replayed])).toEqual(["completed"]);
    expect((await owner.session.rpc.billing.overview()).subscription?.cancelAtPeriodEnd).toBe(true);
  });

  it("lists invoices", async () => {
    const { owner } = await workspace();
    expect(await owner.session.rpc.billing.invoices()).toEqual([]);
    await expectError(owner.session.rpc.billing.portal(), "NO_SUBSCRIPTION");
    await subscribe(owner.session);
    const invoices = await owner.session.rpc.billing.invoices();
    expect(invoices).toEqual([
      expect.objectContaining({
        status: "paid",
        amount: 0,
        currency: "usd",
        url: expect.any(String),
      }),
    ]);
  });

  it("deleting a workspace cancels its subscription first", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const response = await owner.session.auth("/organization/delete", { organizationId: orgId });
    expect(response.status).toBe(200);
    expect(stripe.subscriptionFor(orgId)?.status).toBe("canceled");
  });

  it("keeps each workspace's billing private", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const client = new pg.Client({ connectionString: harness.testDb.urlFor("app_api") });
    await client.connect();
    const unscoped = await client.query("SELECT id FROM billing.subscription");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [randomUUID()]);
    const other = await client.query("SELECT id FROM billing.subscription");
    await client.query("COMMIT");
    await client.end();
    expect(unscoped.rowCount).toBe(0);
    expect(other.rowCount).toBe(0);
    expect(await sql("SELECT 1 FROM billing.subscription WHERE org_id = $1", [orgId])).toHaveLength(
      1,
    );
  });
});

describe("what isn't the app's", () => {
  it("ignores subscriptions made outside the app, and their failed payments", async () => {
    const { orgId } = await workspace();
    const foreign: Stripe.Subscription[] = [];
    const states = await handled(async () => {
      foreign.push(
        await outsideSubscription(),
        await outsideSubscription({ metadata: { orgId: "not-a-workspace" } }),
        await outsideSubscription({ metadata: { orgId: randomUUID() } }),
        await outsideSubscription({ price: OTHER, metadata: { orgId } }),
      );
      for (const subscription of foreign) {
        await fetch(`${stripe.url}/__fake/subscriptions/${subscription.id}/payment-failed`, {
          method: "POST",
        });
      }
    });
    expect(states.length).toBeGreaterThan(0);
    expect(new Set(states)).toEqual(new Set(["completed"]));
    expect(
      await sql("SELECT id FROM billing.subscription WHERE id = ANY($1)", [
        foreign.map((subscription) => subscription.id),
      ]),
    ).toEqual([]);
  });

  it("takes events it has nothing to do with, and does nothing", async () => {
    const stripeEvent = (type: string, object: Record<string, unknown>) =>
      queueEvent("stripe.event_received.v1", `evt_${randomUUID()}`, {
        inboundEventId: randomUUID(),
        stripeEventId: `evt_${randomUUID()}`,
        type,
        object,
      });
    const jobs = [
      await queueEvent("todo.created.v1", randomUUID(), { todoId: randomUUID(), title: "x" }),
      await stripeEvent("customer.created", { id: "cus_elsewhere" }),
      await stripeEvent("invoice.paid", { id: "in_one_off", parent: null }),
      await stripeEvent("checkout.session.completed", { id: "cs_payment", subscription: null }),
    ];
    expect(await settled(jobs)).toEqual(["completed", "completed", "completed", "completed"]);
  });
});

describe("keeping in sync, edge cases", () => {
  it("warns when a workspace ends up with two live subscriptions", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const first = stripe.subscriptionFor(orgId);
    const { BillingService } = await import("../src/modules/billing");
    const billing = harness.app.get(BillingService) as unknown as {
      log: { error: (...args: unknown[]) => void };
    };
    const error = vi.spyOn(billing.log, "error");
    // A second one, paid in the moment before the first checkout closed it.
    await handled(() =>
      outsideSubscription({ price: YEARLY, metadata: { orgId } }, first?.customer),
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, others: [first?.id] }),
      expect.stringContaining("refund one"),
    );
    error.mockRestore();
  });

  it("leaves Stripe alone when the seats already match, or there's no paid plan", async () => {
    const free = await workspace();
    await join(free.owner.session, free.orgId);
    const freeJobs = await relayMembership(free.orgId);
    const paid = await workspace();
    await subscribe(paid.owner.session);
    const updates = () =>
      stripe.events.filter(
        (event) =>
          event.type === "customer.subscription.updated" &&
          (event.object as { metadata: { orgId?: string } }).metadata.orgId === paid.orgId,
      ).length;
    const before = updates();
    expect(await settled([...freeJobs, ...(await relayMembership(paid.orgId))])).not.toContain(
      "failed",
    );
    expect(stripe.subscriptionFor(free.orgId)).toBeUndefined();
    expect(stripe.subscriptionFor(paid.orgId)?.items.data[0]?.quantity).toBe(1);
    expect(updates()).toBe(before);
  });

  it("leaves Stripe alone when only our copy of the seats is behind", async () => {
    // Stripe already has the member count, as when its webhook hasn't reached us yet: the
    // copy here says otherwise, and nothing is sent.
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    const { BillingService } = await import("../src/modules/billing");
    const billing = harness.app.get(BillingService) as unknown as {
      repository: { current: (orgId: OrgId) => Promise<{ quantity: number } | null> };
      syncSeats: (orgId: OrgId) => Promise<void>;
    };
    const current = billing.repository.current.bind(billing.repository);
    const stale = vi.spyOn(billing.repository, "current").mockImplementationOnce(async (id) => {
      const row = await current(id);
      return row && { ...row, quantity: 5 };
    });
    const updated = () =>
      stripe.events.filter(
        (event) =>
          event.type === "customer.subscription.updated" &&
          (event.object as { metadata: { orgId?: string } }).metadata.orgId === orgId,
      ).length;
    const before = updated();
    await billing.syncSeats(orgId);
    expect(stale).toHaveBeenCalledOnce();
    expect(stripe.subscriptionFor(orgId)?.items.data[0]?.quantity).toBe(1);
    expect(updated()).toBe(before);
    stale.mockRestore();
  });

  it("lists a drafted renewal, which has no number or page yet", async () => {
    const { owner, orgId } = await workspace();
    await subscribe(owner.session);
    await fetch(
      `${stripe.url}/__fake/subscriptions/${stripe.subscriptionFor(orgId)?.id}/invoice?status=draft`,
      {
        method: "POST",
      },
    );
    const [draft] = await owner.session.rpc.billing.invoices();
    expect(draft).toMatchObject({ status: "draft", number: null, url: null });
  });

  it("opens a new checkout when the one on record can't be read back", async () => {
    const { owner, orgId } = await workspace();
    // Say, one made with another Stripe key before the keys were rotated.
    await harness.redis.set(`billing:checkout:${orgId}`, "cs_unknown", "EX", 60);
    const { url } = await owner.session.rpc.billing.checkout({ interval: "month" });
    expect((await pay(url)).status).toBe(303);
  });

  it("opens a new checkout even when the earlier one can't be closed any more", async () => {
    const { owner } = await workspace();
    const monthly = await owner.session.rpc.billing.checkout({ interval: "month" });
    // It expired on its own meanwhile.
    await sdk().checkout.sessions.expire(new URL(monthly.url).pathname.split("/").at(-1) as string);
    const yearly = await owner.session.rpc.billing.checkout({ interval: "year" });
    expect(yearly.url).not.toBe(monthly.url);
    const paid = await fetch(`${yearly.url}/pay`, { method: "POST", redirect: "manual" });
    expect(paid.status).toBe(303);
  });
});
