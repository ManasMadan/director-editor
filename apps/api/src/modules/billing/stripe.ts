/** The Stripe client, or null when billing is off. */
import Stripe from "stripe";
import * as z from "zod";
import { env } from "../../env";
import { features } from "../../features";

export const STRIPE = Symbol("STRIPE");

export function createStripe(): Stripe | null {
  if (!features.billing || !env.STRIPE_SECRET_KEY) {
    return null;
  }
  const api = env.STRIPE_API_URL ? new URL(env.STRIPE_API_URL) : null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    // Retries reuse one idempotency key, so a retried write never happens twice.
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "boilerplate" },
    ...(api && {
      host: api.hostname,
      port: Number(api.port),
      protocol: z.enum(["http", "https"]).parse(api.protocol.replace(":", "")),
    }),
  });
}
