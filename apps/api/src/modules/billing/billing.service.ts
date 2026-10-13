/**
 * Billing per organization (see packages/contracts billing for plans).
 *
 * Stripe is the source of truth. Whenever anything about a subscription changes, its
 * webhook reaches `sync`, which reads the subscription back from Stripe and overwrites
 * our row, so duplicated or out-of-order events can't leave stale state behind. Rows are
 * matched to the organization by the `orgId` we put in the customer's and subscription's
 * metadata when checkout starts.
 *
 * With billing off (no Stripe configured), every organization has every entitlement.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { BillingOverview } from "@repo/contracts/api";
import {
  type BillingInterval,
  billingIntervals,
  type Entitlement,
  type Entitlements,
  PAID_STATUSES,
  type PlanName,
  planNames,
  plans,
  subscriptionStatuses,
  unlimited,
} from "@repo/contracts/billing";
import { type OrgId, orgIdSchema } from "@repo/contracts/ids";
import { fieldOf, required } from "@repo/contracts/objects";
import { DAY_S, HOUR_MS } from "@repo/contracts/time";
import { tenantTx } from "@repo/db";
import {
  AppError,
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  InjectRedis,
  PinoLogger,
  type Redis,
} from "@repo/nest-common";
import type Stripe from "stripe";
import * as z from "zod";
import { env } from "../../env";
import { BillingRepository, type SubscriptionData } from "./billing.repository";
import { STRIPE } from "./stripe";

// The subscription row's text columns, parsed rather than cast.
const paid: ReadonlySet<string> = new Set(PAID_STATUSES);
const planName = z.enum(planNames);
const subscriptionStatus = z.enum(subscriptionStatuses);
const billingInterval = z.enum(billingIntervals);

/**
 * Runs a Stripe call; Stripe failing (down, slow, refusing our request) becomes
 * UPSTREAM_UNAVAILABLE, with Stripe's error as the cause (logged: it's a 5xx), instead
 * of an unexplained INTERNAL. Anything else is ours and passes through.
 */
export async function fromStripe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const type = fieldOf(error, "type");
    if (typeof type === "string" && type.startsWith("Stripe")) {
      throw new AppError("UPSTREAM_UNAVAILABLE", { cause: error });
    }
    throw error;
  }
}

/** How long Stripe keeps a checkout session open (its default, 24 hours). */
const CHECKOUT_SESSION_SECONDS = DAY_S;

/** The workspace a Stripe object's metadata names, if it's one of ours. */
const orgIdIn = (metadata: Stripe.Metadata) => orgIdSchema.safeParse(metadata.orgId).data;

/** The plan a subscription row gives (free unless it's a paid status). */
function planOf(subscription: { status: string; plan: string } | null): PlanName {
  return subscription && paid.has(subscription.status) ? planName.parse(subscription.plan) : "free";
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(STRIPE) private readonly stripe: Stripe | null,
    @InjectDatabase() private readonly database: Database,
    private readonly repository: BillingRepository,
    @InjectPinoLogger(BillingService.name) private readonly log: PinoLogger,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  get enabled() {
    return this.stripe !== null;
  }

  private get client() {
    if (!this.stripe) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "billing" } });
    }
    return this.stripe;
  }

  private prices(): Record<string, { plan: PlanName; interval: BillingInterval }> {
    return {
      [required(env.STRIPE_PRICE_PRO_MONTHLY, "STRIPE_PRICE_PRO_MONTHLY")]: {
        plan: "pro",
        interval: "month",
      },
      [required(env.STRIPE_PRICE_PRO_YEARLY, "STRIPE_PRICE_PRO_YEARLY")]: {
        plan: "pro",
        interval: "year",
      },
    };
  }

  async entitlements(orgId: OrgId): Promise<Entitlements> {
    if (!this.enabled) {
      return unlimited;
    }
    return plans[planOf(await this.repository.current(orgId))].entitlements;
  }

  /** Throws ENTITLEMENT_REQUIRED unless the organization's plan includes `entitlement`. */
  async require(orgId: OrgId, entitlement: Exclude<Entitlement, "members">) {
    if (!(await this.entitlements(orgId))[entitlement]) {
      throw new AppError("ENTITLEMENT_REQUIRED", { params: { entitlement } });
    }
  }

  async overview(orgId: OrgId): Promise<BillingOverview> {
    // One read of the subscription, the plan and its entitlements taken from that same
    // row: separate reads could straddle a sync and show a plan with no subscription.
    const [members, subscription] = await Promise.all([
      this.repository.memberCount(orgId),
      this.enabled ? this.repository.current(orgId) : null,
    ]);
    const plan = this.enabled ? planOf(subscription) : "pro";
    const entitlements = this.enabled ? plans[plan].entitlements : unlimited;
    return {
      enabled: this.enabled,
      plan,
      entitlements,
      members,
      subscription: subscription && {
        status: subscriptionStatus.parse(subscription.status),
        interval: billingInterval.parse(subscription.interval),
        seats: subscription.quantity,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        trialEnd: subscription.trialEnd,
      },
    };
  }

  async checkout(orgId: OrgId, interval: BillingInterval) {
    const stripe = this.client;
    const current = await this.repository.current(orgId);
    if (current && paid.has(current.status)) {
      throw new AppError("ALREADY_SUBSCRIBED");
    }
    const customer = await this.customer(orgId);
    // One free trial per organization (and per card: see oneTrialPerCard).
    const trial = env.STRIPE_TRIAL_DAYS > 0 && !(await this.repository.hadSubscription(orgId));
    const price = interval === "month" ? env.STRIPE_PRICE_PRO_MONTHLY : env.STRIPE_PRICE_PRO_YEARLY;
    const seats = Math.max(1, await this.repository.memberCount(orgId));
    // What the session sells. A workspace has one checkout open at a time, so it can't end
    // up paying twice: asking again for the same offer gets the open session back, and a
    // new session (another interval, or the seats changed) expires the one before.
    const offer = `${price}x${seats}${trial ? `+${env.STRIPE_TRIAL_DAYS}d` : ""}`;
    const slot = `billing:checkout:${orgId}`;
    const previous = await this.redis.get(slot);
    if (previous) {
      // Whatever keeps us from reading it back (gone, Stripe down), a new session is made
      // instead, and that call surfaces an outage.
      const open = await stripe.checkout.sessions.retrieve(previous).catch(() => null);
      if (open?.status === "open" && open.metadata?.offer === offer) {
        return { url: required(open.url, "the checkout session's URL") };
      }
    }
    const settings = new URL("/settings/billing", env.WEB_URL);
    const hour = Math.floor(Date.now() / HOUR_MS);
    const session = await fromStripe(() =>
      stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer,
          client_reference_id: orgId,
          metadata: { orgId, offer },
          line_items: [{ price: required(price, "the plan's price"), quantity: seats }],
          subscription_data: {
            metadata: { orgId },
            ...(trial && { trial_period_days: env.STRIPE_TRIAL_DAYS }),
          },
          allow_promotion_codes: true,
          success_url: `${settings.toString()}?checkout=done`,
          cancel_url: settings.toString(),
        },
        // Requests racing each other (a double click, two tabs) saw the same previous
        // session, so they send the same key and Stripe answers all of them with one
        // session. The key names that previous session and the offer, so it's never
        // replayed for a closed session or for other parameters (Stripe refuses those);
        // the hour bounds a replay should Redis lose the slot.
        { idempotencyKey: `checkout-${orgId}-${offer}-${previous ?? "none"}-${hour}` },
      ),
    );
    // Atomic swap: of two checkouts at once, the later one sees (and expires) the earlier.
    const replaced = await this.redis.set(slot, session.id, "EX", CHECKOUT_SESSION_SECONDS, "GET");
    if (replaced && replaced !== session.id) {
      await stripe.checkout.sessions.expire(replaced).catch((error: unknown) => {
        // Already paid or expired: nothing left to close.
        this.log.info({ sessionId: replaced, error }, "earlier checkout session not expired");
      });
    }
    // A hosted checkout session always has one.
    return { url: required(session.url, "the checkout session's URL") };
  }

  async portal(orgId: OrgId) {
    const stripe = this.client;
    const row = await this.repository.customer(orgId);
    if (!row) {
      throw new AppError("NO_SUBSCRIPTION");
    }
    const session = await fromStripe(() =>
      stripe.billingPortal.sessions.create({
        customer: row.stripeCustomerId,
        return_url: new URL("/settings/billing", env.WEB_URL).toString(),
      }),
    );
    return { url: session.url };
  }

  async invoices(orgId: OrgId) {
    const stripe = this.client;
    const row = await this.repository.customer(orgId);
    if (!row) {
      return [];
    }
    const list = await fromStripe(() =>
      stripe.invoices.list({ customer: row.stripeCustomerId, limit: 24 }),
    );
    return list.data.map((invoice) => ({
      id: invoice.id as string,
      number: invoice.number ?? null,
      // Always set on a listed invoice (draft, open, paid, uncollectible or void).
      status: required(invoice.status, "the invoice's status"),
      amount: invoice.amount_due,
      currency: invoice.currency,
      createdAt: new Date(invoice.created * 1000),
      url: invoice.hosted_invoice_url ?? null,
    }));
  }

  /** The organization's Stripe customer, created once (concurrent first calls agree). */
  private async customer(orgId: OrgId) {
    const stripe = this.client;
    const existing = await this.repository.customer(orgId);
    if (existing) {
      return existing.stripeCustomerId;
    }
    const org = await this.repository.organizationName(orgId);
    const created = await fromStripe(() =>
      stripe.customers.create(
        { name: org.name, metadata: { orgId } },
        // The same organization always maps to the same customer, even when two admins
        // click at once or a request is retried.
        { idempotencyKey: `customer-${orgId}` },
      ),
    );
    await this.repository.saveCustomer(orgId, created.id);
    return created.id;
  }

  /** Mirrors a subscription from Stripe. Unknown prices and organizations are ignored. */
  async sync(subscriptionId: string) {
    const stripe = this.client;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const orgId = orgIdIn(subscription.metadata);
    const item = subscription.items.data[0];
    const price = item && this.prices()[item.price.id];
    if (!orgId || !item || !price) {
      this.log.warn({ subscriptionId }, "ignoring a subscription that isn't ours");
      return;
    }
    if (!(await this.repository.organization(orgId))) {
      return; // deleted meanwhile
    }
    const data: SubscriptionData = {
      plan: price.plan,
      status: subscription.status,
      priceId: item.price.id,
      interval: price.interval,
      // Per-seat (licensed) prices always carry one.
      quantity: required(item.quantity, "the subscription's seats"),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    };
    const others = await tenantTx(this.database.write, orgId, async (tx) => {
      await this.repository.saveSubscription(tx, subscription.id, orgId, data);
      return this.repository.otherPaid(tx, orgId, subscription.id);
    });
    if (data.status === "trialing") {
      await this.oneTrialPerCard(subscription);
    }
    // Checkout keeps one session open per workspace, so this shouldn't happen; if it does
    // (a session paid in the moment before it was expired), someone must refund one.
    if (paid.has(data.status) && others.length > 0) {
      this.log.error(
        { orgId, subscriptionId: subscription.id, others: others.map((other) => other.id) },
        "workspace has more than one live subscription: refund one in Stripe",
      );
    }
  }

  /**
   * One free trial per card: a trial paid for with a card that already had one, in any
   * workspace, ends now (Stripe charges the card at once). A card's fingerprint is the
   * same in every Stripe customer, so a new workspace or a new account doesn't reset it.
   */
  private async oneTrialPerCard(subscription: Stripe.Subscription) {
    const stripe = this.client;
    const method = subscription.default_payment_method;
    // A trial started without a card on file (Checkout's "if_required") has nothing to check.
    if (typeof method !== "string") {
      return;
    }
    const card = (await stripe.paymentMethods.retrieve(method)).card?.fingerprint;
    // Only cards have fingerprints; other methods keep their trial (Stripe Radar rules can
    // cover them).
    if (!card) {
      return;
    }
    if ((await this.repository.claimTrial(card, subscription.id)) === subscription.id) {
      return;
    }
    await stripe.subscriptions.update(
      subscription.id,
      { trial_end: "now" },
      { idempotencyKey: `end-trial-${subscription.id}` },
    );
    this.log.info({ subscriptionId: subscription.id }, "this card already had a trial: ended it");
  }

  /** Paid plans are per seat: keeps the subscription's quantity at the member count. */
  async syncSeats(orgId: OrgId) {
    const stripe = this.client;
    const current = await this.repository.current(orgId);
    if (!current || !paid.has(current.status)) {
      return;
    }
    const seats = Math.max(1, await this.repository.memberCount(orgId));
    if (seats === current.quantity) {
      return;
    }
    const subscription = await stripe.subscriptions.retrieve(current.id);
    const item = subscription.items.data[0];
    if (!item || item.quantity === seats) {
      return;
    }
    await stripe.subscriptions.update(
      current.id,
      { items: [{ id: item.id, quantity: seats }], proration_behavior: "create_prorations" },
      { idempotencyKey: `seats-${current.id}-${seats}-${item.quantity}` },
    );
  }

  /** Before an organization is deleted: nothing may keep charging for it. */
  async cancelFor(orgId: OrgId) {
    if (!this.stripe) {
      return;
    }
    const live = await this.repository.live(orgId);
    for (const { id } of live) {
      await this.stripe.subscriptions.cancel(id, {}, { idempotencyKey: `cancel-${id}` });
    }
  }

  /** The organization a subscription belongs to (by its metadata), if it still exists. */
  async orgFor(subscriptionId: string) {
    const subscription = await this.client.subscriptions.retrieve(subscriptionId);
    const orgId = orgIdIn(subscription.metadata);
    return orgId ? this.repository.organization(orgId) : null;
  }
}
