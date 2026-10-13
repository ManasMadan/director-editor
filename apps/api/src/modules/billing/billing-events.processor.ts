/**
 * Billing's share of domain events (`eventSubscribers["events-billing"]`):
 *
 *   - Stripe's (received and verified by apps/webhooks): any change to a subscription
 *     re-syncs it; a failed renewal also tells the organization's owners and admins;
 *   - membership changes: a paid plan's seat count follows the member count.
 *
 * Handlers are idempotent (syncs overwrite, seat updates are keyed, notifications use
 * the event id), so a redelivered event is harmless. It runs in the API because the API
 * owns the billing schema and holds the Stripe key; at scale it moves to its own worker
 * deployment unchanged.
 */
import { Processor } from "@nestjs/bullmq";
import { events } from "@repo/contracts/events";
import {
  eventSubscribers,
  parseJob,
  queuePrefix,
  type RoutedEvent,
  type UncheckedJob,
} from "@repo/jobs";
import { JobProcessor, runJob } from "@repo/nest-common";
import * as z from "zod";
import { env } from "../../env";
import { type CriticalNotifications, InjectCriticalNotifications } from "../../notifications";
import { BillingService } from "./billing.service";

// Stripe events whose object is, or points at, a subscription.
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/**
 * What a failed payment's alert needs from the invoice. Parsed, not defaulted: an alert
 * saying "a payment of 0 USD failed" is worse than a job that fails loudly.
 */
const failedInvoice = z.object({
  amount_due: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

/** The fields of a Stripe event's object that lead to its subscription, whichever it is. */
const stripeObject = z.object({
  id: z.string().optional(),
  subscription: z.string().nullish(),
  parent: z
    .object({
      subscription_details: z.object({ subscription: z.string().optional() }).nullish(),
    })
    .nullish(),
});

/** The subscription a Stripe event is about, or undefined when it isn't about one. */
function subscriptionOf(type: string, found: z.infer<typeof stripeObject>) {
  if (SUBSCRIPTION_EVENTS.has(type)) {
    return found.id;
  }
  if (type === "checkout.session.completed") {
    return found.subscription;
  }
  // An invoice outside a subscription (a one-off charge) has no subscription details.
  if (type.startsWith("invoice.")) {
    return found.parent?.subscription_details?.subscription;
  }
  return undefined;
}

@Processor("events-billing", { concurrency: 5, prefix: queuePrefix("events-billing") })
export class BillingEventsProcessor extends JobProcessor {
  constructor(
    private readonly billing: BillingService,
    @InjectCriticalNotifications() private readonly notifications: CriticalNotifications,
  ) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload: event } = parseJob("events-billing", "event", job.data);
    const { name } = event;
    // An event routed here by a newer relay this build doesn't know yet.
    if (!this.billing.enabled || !eventSubscribers["events-billing"](name)) {
      return;
    }
    await runJob(meta, `event:${event.id}`, () => this.handle(event.id, name, event.payload));
  }

  private async handle(eventId: string, name: RoutedEvent<"events-billing">, raw: unknown) {
    if (name === "org.member_added.v1" || name === "org.member_removed.v1") {
      const { organizationId } = events[name].parse(raw);
      await this.billing.syncSeats(organizationId);
      return;
    }
    const { type, object } = events[name].parse(raw);
    const found = stripeObject.parse(object);
    const subscriptionId = subscriptionOf(type, found);
    if (!subscriptionId) {
      return;
    }
    await this.billing.sync(subscriptionId);

    if (type === "invoice.payment_failed") {
      const invoice = failedInvoice.parse(object);
      const org = await this.billing.orgFor(subscriptionId);
      if (!org) {
        return;
      }
      await this.notifications.add(
        "send",
        {
          template: "billing.payment-failed",
          to: { orgId: org.id, roles: ["owner", "admin"] },
          data: {
            organizationName: org.name,
            amount: invoice.amount_due,
            currency: invoice.currency.toUpperCase(),
            billingUrl: new URL("/settings/billing", env.WEB_URL).toString(),
          },
        },
        // One alert per failed payment, however often the event is delivered.
        { jobId: `payment-failed-${eventId}` },
      );
    }
  }
}
