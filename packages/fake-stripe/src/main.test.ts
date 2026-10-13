/** `bun run --filter @repo/fake-stripe start`: the fake, configured from the environment. */
import { afterEach, describe, expect, it, vi } from "vitest";

const REQUIRED = {
  STRIPE_SECRET_KEY: "sk_test_main",
  STRIPE_WEBHOOK_SECRET: "whsec_main",
  STRIPE_PRICE_PRO_MONTHLY: "price_main_monthly",
  STRIPE_PRICE_PRO_YEARLY: "price_main_yearly",
  STRIPE_FAKE_PORT: "0",
  WEBHOOKS_PORT: "4104",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

function configure(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({ ...REQUIRED, ...env })) {
    vi.stubEnv(name, value);
  }
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("starting the fake", () => {
  it("listens on the port given with the key and says where", async () => {
    const write = configure({
      STRIPE_FAKE_PORT: "0",
      STRIPE_FAKE_WEBHOOK_URL: "http://127.0.0.1:1/",
    });
    const { fake } = await import("./main");
    try {
      expect(write).toHaveBeenCalledWith(`fake Stripe on ${fake.url}\n`);
      const customers = (key: string) =>
        fetch(`${fake.url}/v1/customers`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
        });
      expect((await customers(REQUIRED.STRIPE_SECRET_KEY)).status).toBe(200);
      expect((await customers("sk_test_other")).status).toBe(401);
    } finally {
      await fake.close();
    }
  });

  it("sends its events to this checkout's webhooks service unless told where", async () => {
    configure({
      STRIPE_FAKE_PORT: "4111",
      STRIPE_FAKE_WEBHOOK_URL: undefined,
      WEBHOOKS_PORT: "4104",
    });
    const startFakeStripe = vi.fn(async () => ({ url: "http://127.0.0.1:4111" }));
    vi.doMock("./index", () => ({ startFakeStripe }));
    try {
      await import("./main");
      expect(startFakeStripe).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 4111,
          webhookUrl: "http://localhost:4104/webhooks/stripe",
        }),
      );
    } finally {
      vi.doUnmock("./index");
    }
  });

  it("refuses to start without a required variable", async () => {
    configure({ STRIPE_PRICE_PRO_YEARLY: "" });
    await expect(import("./main")).rejects.toThrow(
      "STRIPE_PRICE_PRO_YEARLY must be set to run the fake Stripe",
    );
  });
});
