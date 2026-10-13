/** The organization's plan (owners and admins only). */
import * as z from "zod";
import { billingIntervals, planNames, subscriptionStatuses } from "../billing";
import { base, errorsOf, WORKSPACE_ERRORS } from "./base";

/** The codes this module's procedures throw, on top of the common ones. */
const errors = errorsOf(
  ...WORKSPACE_ERRORS,
  "FEATURE_DISABLED",
  "UPSTREAM_UNAVAILABLE",
  "ALREADY_SUBSCRIBED",
  "NO_SUBSCRIPTION",
);

const entitlementsSchema = z.object({
  members: z.number().int().nullable(),
  webhooks: z.boolean(),
});

const billingOverviewSchema = z.object({
  /** False when this deployment has billing off: everything is included. */
  enabled: z.boolean(),
  plan: z.enum(planNames),
  entitlements: entitlementsSchema,
  /** How many members the organization has (the seats a paid plan bills for). */
  members: z.number().int(),
  subscription: z
    .object({
      status: z.enum(subscriptionStatuses),
      interval: z.enum(billingIntervals),
      seats: z.number().int(),
      currentPeriodEnd: z.date(),
      cancelAtPeriodEnd: z.boolean(),
      trialEnd: z.date().nullable(),
    })
    .nullable(),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;

const invoiceSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  /** In the smallest currency unit (cents). */
  amount: z.number().int(),
  currency: z.string(),
  createdAt: z.date(),
  /** Stripe's hosted page for the invoice (view, pay, download). */
  url: z.url().nullable(),
});

/** Each one asks Stripe for a page; shared by the workspace's admins. */
const stripeSessions = {
  name: "billing-sessions",
  points: 10,
  windowSeconds: 60,
  per: "org",
} as const;

const route = (method: "GET" | "POST", path: `/${string}`, summary: string) =>
  base.errors(errors).route({ method, path, tags: ["Billing"], summary });

export const billingContract = {
  overview: route("GET", "/billing", "The organization's plan and subscription").output(
    billingOverviewSchema,
  ),
  /** A Stripe Checkout page to subscribe to the paid plan (ALREADY_SUBSCRIBED if it is). */
  checkout: route("POST", "/billing/checkout", "Start a subscription")
    .meta({ rateLimit: stripeSessions })
    .input(z.object({ interval: z.enum(billingIntervals) }))
    .output(z.object({ url: z.url() })),
  /** Stripe's billing portal: payment method, plan changes, cancelling, invoices. */
  portal: route("POST", "/billing/portal", "Manage the subscription")
    .meta({ rateLimit: stripeSessions })
    .output(z.object({ url: z.url() })),
  invoices: route("GET", "/billing/invoices", "Past invoices, newest first").output(
    z.array(invoiceSchema),
  ),
};
