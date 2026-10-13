import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function stripeWith(variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    vi.stubEnv(name, value);
  }
  const { createStripe } = await import("./stripe");
  return createStripe();
}

const BILLING = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PRICE_PRO_MONTHLY: "price_m",
  STRIPE_PRICE_PRO_YEARLY: "price_y",
};

describe("the Stripe client", () => {
  it("doesn't exist while billing is off", async () => {
    expect(
      await stripeWith({
        STRIPE_SECRET_KEY: "",
        STRIPE_PRICE_PRO_MONTHLY: "",
        STRIPE_PRICE_PRO_YEARLY: "",
      }),
    ).toBeNull();
  });

  it("talks to Stripe, or to the fake Stripe STRIPE_API_URL names", async () => {
    const real = await stripeWith({ ...BILLING, STRIPE_API_URL: "" });
    expect(real?.getApiField("host")).toBe("api.stripe.com");
    vi.resetModules();
    const fake = await stripeWith({ ...BILLING, STRIPE_API_URL: "http://127.0.0.1:12111" });
    expect([
      fake?.getApiField("host"),
      fake?.getApiField("port"),
      fake?.getApiField("protocol"),
    ]).toEqual(["127.0.0.1", 12111, "http"]);
  });
});
