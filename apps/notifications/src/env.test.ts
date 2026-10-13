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
  SMS_PROVIDER: "",
};
const twilio = {
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM: "+15005550006",
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

  it("texts through the email sink by default outside production", async () => {
    const { env } = await load({ SMS_PROVIDER: "" });
    expect(env.SMS_PROVIDER).toBe("email");
  });

  it("starts in production with authenticated SMTP over TLS, and nothing to text with", async () => {
    const { env } = await load(production);
    expect(env.SMS_PROVIDER).toBeUndefined();
    expect(env.SMTP_URL).toBe(production.SMTP_URL);
  });

  it("refuses production SMTP that isn't authenticated and encrypted", async () => {
    await expect(
      load({ ...production, SMTP_URL: "smtp://mail.example.com:587" }),
    ).rejects.toThrow();
  });

  it("needs every Twilio variable when texting through Twilio", async () => {
    expect((await load(twilio)).env.TWILIO_FROM).toBe("+15005550006");
    for (const missing of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]) {
      vi.resetModules();
      await expect(load({ ...twilio, [missing]: "" }), missing).rejects.toThrow(
        "SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM",
      );
    }
  });

  it("refuses the test hooks and the email sink in production", async () => {
    for (const hook of <Record<string, string>[]>[
      { FCM_TOKEN_URL: "http://127.0.0.1:1/token" },
      { FCM_API_URL: "http://127.0.0.1:1" },
      { WEB_PUSH_TEST_ORIGIN: "http://127.0.0.1:1" },
      { ...twilio, TWILIO_API_URL: "http://127.0.0.1:1" },
      { SMS_PROVIDER: "email" },
    ]) {
      vi.resetModules();
      await expect(load({ ...production, ...hook }), JSON.stringify(hook)).rejects.toThrow(
        /are for development and tests only/,
      );
    }
  });

  it("turns each push platform on only with all of its variables", async () => {
    const off = { VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" };
    expect((await load(off)).pushPlatforms).toEqual({ android: false, ios: false, web: false });
    vi.unstubAllEnvs();
    vi.resetModules();
    const { pushPlatforms } = await load({
      FCM_PROJECT_ID: "p",
      FCM_CLIENT_EMAIL: "push@p.iam.gserviceaccount.com",
      FCM_PRIVATE_KEY: "key",
    });
    expect(pushPlatforms).toMatchObject({ android: true, web: true });
    vi.resetModules();
    await expect(load({ APNS_KEY_ID: "KEYID12345" })).rejects.toThrow(
      "APNs needs all of its variables set, or none",
    );
  });
});
