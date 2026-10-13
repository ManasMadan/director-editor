/**
 * Plans and what they allow. Billing is per organization: the plan is the
 * organization's, and every member gets what it allows.
 *
 * Prices live in Stripe (the API maps each plan and interval to a price id from its
 * environment); this file says what each plan unlocks. When billing is off (no Stripe
 * configured, e.g. self-hosted), every organization gets everything.
 *
 * Adding an entitlement: add it to both plans here, check it where the feature is used
 * (`BillingService.require` in apps/api), and hide or badge it in clients from
 * `billing.overview`.
 */
import { keysOf } from "./objects";
export const plans = {
  free: { entitlements: { members: 3, webhooks: false } },
  /** Per seat: the subscription's quantity follows the member count. */
  pro: { entitlements: { members: null, webhooks: true } },
} as const satisfies Record<string, { entitlements: Entitlements }>;

export interface Entitlements {
  /** Most members (and pending invitations) an organization may have; null = no limit. */
  members: number | null;
  /** Customer webhooks (settings, endpoints, deliveries). */
  webhooks: boolean;
}

export type PlanName = keyof typeof plans;
export const planNames = keysOf(plans);
export const billingIntervals = ["month", "year"] as const;
export type BillingInterval = (typeof billingIntervals)[number];
export type Entitlement = keyof Entitlements;

/** Everything, for when billing is off. */
export const unlimited: Entitlements = { members: null, webhooks: true };

/** Subscription states (Stripe's) and whether they give the paid plan. */
export const subscriptionStatuses = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

/** A failed payment keeps the plan while Stripe retries (past_due); after that it lapses. */
export const PAID_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];
