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
  return import("./env");
}

/** What production needs that the test environment doesn't give it. */
const production = {
  NODE_ENV: "production",
  SMTP_URL: "smtps://no-reply%40example.com:secret@mail.example.com",
};

describe("notifications environment", () => {
  it("listens on NOTIFICATIONS_PORT from the local .env, on PORT over it, else on 3003", async () => {
    const listensOn = async (variables: Record<string, string>) => {
      vi.resetModules();
      return (await load(variables)).env.PORT;
    };
    expect(await listensOn({ PORT: "", NOTIFICATIONS_PORT: "4103" })).toBe(4103);
    expect(await listensOn({ PORT: "4200", NOTIFICATIONS_PORT: "4103" })).toBe(4200);
    expect(await listensOn({ PORT: "", NOTIFICATIONS_PORT: "" })).toBe(3003);
  });

  it("starts in production with authenticated SMTP over TLS", async () => {
    const { env } = await load(production);
    expect(env.SMTP_URL).toBe(production.SMTP_URL);
  });

  it("refuses production SMTP that isn't authenticated and encrypted", async () => {
    await expect(
      load({ ...production, SMTP_URL: "smtp://mail.example.com:587" }),
    ).rejects.toThrow();
  });
});
