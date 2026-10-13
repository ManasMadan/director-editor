/** The API refuses to start on configuration that's wrong, or unsafe in production. */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(variables: Record<string, string>) {
  for (const [name, value] of Object.entries(variables)) {
    vi.stubEnv(name, value);
  }
  const { env } = await import("./env");
  const { features } = await import("./features");
  return { env, features };
}

describe("the environment", () => {
  it("listens on API_PORT from the local .env, on PORT over it, else on 3001", async () => {
    const listensOn = async (variables: Record<string, string>) => {
      vi.resetModules();
      return (await load(variables)).env.PORT;
    };
    expect(await listensOn({ PORT: "", API_PORT: "4101" })).toBe(4101);
    expect(await listensOn({ PORT: "4200", API_PORT: "4101" })).toBe(4200);
    expect(await listensOn({ PORT: "", API_PORT: "" })).toBe(3001);
  });

  it("parses versioned auth secrets, and refuses malformed ones", async () => {
    const { env } = await load({ BETTER_AUTH_SECRETS: `2:${"n".repeat(40)}` });
    expect(env.BETTER_AUTH_SECRETS).toEqual([{ version: 2, value: "n".repeat(40) }]);
    vi.resetModules();
    await expect(load({ BETTER_AUTH_SECRETS: "not-versioned" })).rejects.toThrow(
      "Invalid environment variables",
    );
  });

  it.each([
    [
      "the fake Stripe",
      { STRIPE_API_URL: "http://127.0.0.1:12111" },
      "STRIPE_API_URL is for tests only",
    ],
    [
      "private webhook addresses",
      { WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "127.0.0.1" },
      "WEBHOOK_ALLOWED_PRIVATE_ADDRESSES must be empty in production",
    ],
  ])("refuses %s in production", async (_, variables, message) => {
    await expect(load({ NODE_ENV: "production", ...variables })).rejects.toThrow(message);
  });
});

describe("optional features", () => {
  it("are off without their configuration", async () => {
    const { features } = await load({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_PRICE_PRO_MONTHLY: "",
      STRIPE_PRICE_PRO_YEARLY: "",
    });
    expect(features).toMatchObject({ google: false, billing: false });
  });

  it("are on with all of it", async () => {
    const { features } = await load({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_PRICE_PRO_MONTHLY: "price_m",
      STRIPE_PRICE_PRO_YEARLY: "price_y",
    });
    expect(features).toMatchObject({ google: true, billing: true });
  });

  it.each([
    [
      "Google sign-in",
      { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" },
      "Google sign-in (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) needs both of its variables set, or neither",
    ],
    [
      "billing",
      { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_PRO_MONTHLY: "", STRIPE_PRICE_PRO_YEARLY: "" },
      "Billing needs STRIPE_SECRET_KEY and both STRIPE_PRICE_PRO_* set, or none",
    ],
  ])("refuse to start %s half configured", async (_, variables, message) => {
    await expect(load(variables)).rejects.toThrow(message);
  });

  it("checks passwords against public breaches in production unless told not to", async () => {
    // Production as it would be: without the local stand-ins the example sets.
    const production = { NODE_ENV: "production", WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: "" };
    expect((await load(production)).env.PASSWORD_BREACH_CHECK).toBe("on");
    vi.resetModules();
    vi.unstubAllEnvs();
    expect((await load({})).env.PASSWORD_BREACH_CHECK).toBe("off");
    vi.resetModules();
    const off = await load({ ...production, PASSWORD_BREACH_CHECK: "off" });
    expect(off.env.PASSWORD_BREACH_CHECK).toBe("off");
  });
});
