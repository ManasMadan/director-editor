import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** env.ts as a fresh process would load it, with these variables. */
async function load(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) {
    vi.stubEnv(key, value);
  }
  return (await import("./env")).env;
}

describe("webhooks environment", () => {
  it("listens on WEBHOOKS_PORT from the local .env, on PORT over it, else on 3004", async () => {
    const listensOn = async (variables: Record<string, string>) => {
      vi.resetModules();
      return (await load(variables)).PORT;
    };
    expect(await listensOn({ PORT: "", WEBHOOKS_PORT: "4104" })).toBe(4104);
    expect(await listensOn({ PORT: "4200", WEBHOOKS_PORT: "4104" })).toBe(4200);
    expect(await listensOn({ PORT: "", WEBHOOKS_PORT: "" })).toBe(3004);
  });

  it("reads the mail server's signing keys, a new and an old one while rotating", async () => {
    const env = await load({ STALWART_WEBHOOK_SECRET: `${"a".repeat(32)}, ${"b".repeat(32)}` });
    expect(env.STALWART_WEBHOOK_SECRET).toEqual(["a".repeat(32), "b".repeat(32)]);
  });
});
