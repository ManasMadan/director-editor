import { AppError } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { fromStripe } from "./billing.service";

describe("a Stripe call", () => {
  it("that Stripe fails becomes UPSTREAM_UNAVAILABLE, with Stripe's error as the cause", async () => {
    const stripeError = Object.assign(
      new Error("An error occurred with our connection to Stripe."),
      {
        type: "StripeConnectionError",
      },
    );
    const error = await fromStripe(() => Promise.reject(stripeError)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 502, cause: stripeError });
  });

  it("passes our own errors, and results, through", async () => {
    const bug = new TypeError("not Stripe's");
    await expect(fromStripe(() => Promise.reject(bug))).rejects.toBe(bug);
    await expect(fromStripe(async () => 42)).resolves.toBe(42);
  });
});
