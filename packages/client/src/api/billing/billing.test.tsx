import type { BillingOverview } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, standIn, until } from "../../../test/stand-in";
import { useCheckoutMutation } from "./checkout";
import { useInvoicesQuery } from "./invoices";
import { useBillingOverviewQuery } from "./overview";
import { usePortalMutation } from "./portal";

const overview = (plan: BillingOverview["plan"]): BillingOverview => ({
  enabled: true,
  plan,
  entitlements: { members: plan === "free" ? 3 : null, webhooks: plan !== "free" },
  members: 1,
  subscription: null,
});

/** Billing whose plan turns paid after `paidAfter` looks (Stripe's webhook arriving). */
function billingApi(paidAfter = Number.POSITIVE_INFINITY) {
  let looks = 0;
  const api = standIn((os) => ({
    billing: {
      overview: os.billing.overview.handler(() => overview(++looks > paidAfter ? "pro" : "free")),
      invoices: os.billing.invoices.handler(() => [
        {
          id: "in_1",
          number: "0001",
          status: "paid",
          amount: 1200,
          currency: "usd",
          createdAt: new Date(0),
          url: null,
        },
      ]),
      checkout: os.billing.checkout.handler(({ input }) => ({
        url: `https://checkout.test/${input.interval}`,
      })),
      portal: os.billing.portal.handler(() => ({ url: "https://portal.test/" })),
    },
  }));
  return { api, looks: () => looks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("billing", () => {
  it("shows the plan, and loads invoices only when asked", async () => {
    const { api } = billingApi();
    let showInvoices = false;
    const { result, rerender } = renderHook(
      () => ({ overview: useBillingOverviewQuery(), invoices: useInvoicesQuery(showInvoices) }),
      api,
    );
    await vi.waitFor(() => expect(result.current.overview.data?.plan).toBe("free"));
    expect(api.calls).not.toContain("billing/invoices");
    showInvoices = true;
    rerender();
    await vi.waitFor(() => expect(result.current.invoices.data).toHaveLength(1));
  });

  it("starts a checkout and opens the portal", async () => {
    const { api } = billingApi();
    const { result } = renderHook(
      () => ({ checkout: useCheckoutMutation(), portal: usePortalMutation() }),
      api,
    );
    await expect(result.current.checkout.mutateAsync({ interval: "year" })).resolves.toEqual({
      url: "https://checkout.test/year",
    });
    await expect(result.current.portal.mutateAsync()).resolves.toEqual({
      url: "https://portal.test/",
    });
  });

  it("after checkout, looks again every two seconds until the plan is paid", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { api, looks } = billingApi(2);
    const { result } = renderHook(() => useBillingOverviewQuery({ untilPaid: true }), api);
    await until(() => expect(looks()).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => expect(looks()).toBe(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await until(() => expect(result.current.data?.plan).toBe("pro"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(looks()).toBe(3);
  });

  it("gives up looking after a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { api, looks } = billingApi();
    renderHook(() => useBillingOverviewQuery({ untilPaid: true }), api);
    await until(() => expect(looks()).toBe(1));
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    await until(() => expect(looks()).toBe(30));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(looks()).toBe(30);
  });
});
