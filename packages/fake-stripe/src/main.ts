/**
 * Runs the fake Stripe for local development and the e2e suite:
 *
 *   bun run --filter @repo/fake-stripe start
 *
 * Point apps/api at it with STRIPE_API_URL (its URL) and STRIPE_SECRET_KEY, and give it
 * the webhook secret apps/webhooks verifies with (STRIPE_WEBHOOK_SECRET).
 */
import { startFakeStripe } from "./index";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to run the fake Stripe`);
  }
  return value;
};

export const fake = await startFakeStripe({
  secretKey: required("STRIPE_SECRET_KEY"),
  webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
  // The webhooks service on this checkout's port (WEBHOOKS_PORT, in the root .env).
  webhookUrl:
    process.env.STRIPE_FAKE_WEBHOOK_URL ??
    `http://localhost:${required("WEBHOOKS_PORT")}/webhooks/stripe`,
  port: Number(required("STRIPE_FAKE_PORT")),
  prices: {
    [required("STRIPE_PRICE_PRO_MONTHLY")]: { interval: "month", unitAmount: 1_200 },
    [required("STRIPE_PRICE_PRO_YEARLY")]: { interval: "year", unitAmount: 12_000 },
  },
});
process.stdout.write(`fake Stripe on ${fake.url}\n`);
