import { AppError } from "@repo/nest-common";
import { describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn: with vi.fn, vitest reported the rejection as this test's
// failure though the code under test had handled it.
const dns = vi.hoisted(() => ({
  answer: async (): Promise<{ address: string; family: number }[]> => [],
}));
vi.mock("node:dns/promises", () => ({ lookup: () => dns.answer() }));
vi.mock("../../env", () => ({ env: { NODE_ENV: "test", WEBHOOK_ALLOWED_PRIVATE_ADDRESSES: [] } }));
const { assertDeliverableUrl } = await import("./webhook-url");
const { env } = await import("../../env");

const dnsError = (code: string) => Object.assign(new Error(code), { code });
const resolvesTo = (address: string) => {
  dns.answer = async () => [{ address, family: 4 }];
};
const fails = (error: Error) => {
  dns.answer = async () => {
    throw error;
  };
};

describe("a webhook endpoint's URL", () => {
  it("is allowed when it resolves only to public addresses", async () => {
    resolvesTo("93.184.216.34");
    await expect(assertDeliverableUrl("https://example.com/hook")).resolves.toBeUndefined();
  });

  it("isn't when the host doesn't exist, or resolves somewhere private", async () => {
    fails(dnsError("ENOTFOUND"));
    await expect(assertDeliverableUrl("https://nope.invalid/")).rejects.toMatchObject({
      code: "WEBHOOK_URL_NOT_ALLOWED",
    });
    resolvesTo("10.0.0.5");
    await expect(assertDeliverableUrl("https://internal.example/")).rejects.toMatchObject({
      code: "WEBHOOK_URL_NOT_ALLOWED",
    });
  });

  it("says DNS failed, not that the URL is wrong, when resolving itself fails", async () => {
    const failure = dnsError("EAI_AGAIN");
    fails(failure);
    const error = await assertDeliverableUrl("https://example.com/hook").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((error as AppError).cause).toBe(failure);
  });

  it("must be https in production", async () => {
    resolvesTo("93.184.216.34");
    Object.assign(env, { NODE_ENV: "production" });
    try {
      await expect(assertDeliverableUrl("http://example.com/hook")).rejects.toMatchObject({
        code: "WEBHOOK_URL_NOT_ALLOWED",
      });
      await expect(assertDeliverableUrl("https://example.com/hook")).resolves.toBeUndefined();
    } finally {
      Object.assign(env, { NODE_ENV: "test" });
    }
  });
});
