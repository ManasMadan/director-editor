import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { LoggerModule } from "@repo/nest-common";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Whether the SMS channel the module builds, with these variables, can text. */
async function enabledWith(variables: Record<string, string>) {
  for (const [key, value] of Object.entries(variables)) {
    vi.stubEnv(key, value);
  }
  const { SmsModule } = await import("./sms.module");
  const { SmsChannel } = await import("./sms.channel");
  @Module({ imports: [LoggerModule.forRoot({ service: "test", level: "silent" }), SmsModule] })
  class AppModule {}
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { enabled } = app.get(SmsChannel);
  await app.close();
  return enabled;
}

describe("SmsModule", () => {
  it("texts through the email sink locally", async () => {
    expect(await enabledWith({ SMS_PROVIDER: "email" })).toBe(true);
  });

  it("texts nothing in production without a provider", async () => {
    expect(
      await enabledWith({
        NODE_ENV: "production",
        SMTP_URL: "smtps://no-reply%40example.com:secret@mail.example.com",
        SMS_PROVIDER: "",
      }),
    ).toBe(false);
  });
});
