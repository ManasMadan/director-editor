import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportsLifecycle } from "./push.module";
import type { PushTransport, PushTransports } from "./push-transport";

describe("push transports at shutdown", () => {
  it("closes every transport that holds something open, and skips those that don't", async () => {
    const send: PushTransport["send"] = async () => ({ ok: true });
    const ios = { send, close: vi.fn() };
    const web = { send, close: vi.fn(async () => undefined) };
    const lifecycle = new TransportsLifecycle({ ios, web, android: { send } });
    await lifecycle.onApplicationShutdown();
    expect(ios.close).toHaveBeenCalledOnce();
    expect(web.close).toHaveBeenCalledOnce();
  });
});

describe("push transports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** The platforms PushModule sets up, with these variables. */
  async function platforms(variables: Record<string, string>) {
    for (const [key, value] of Object.entries(variables)) {
      vi.stubEnv(key, value);
    }
    // Fresh copies, after the module reset: the same injection tokens as PushModule's.
    const { DatabaseModule, LoggerModule } = await import("@repo/nest-common");
    const { PushModule } = await import("./push.module");
    @Module({
      imports: [
        LoggerModule.forRoot({ service: "test", level: "silent" }),
        // The channel reads devices from here; nothing is queried in this test.
        DatabaseModule.forRoot({
          url: process.env.NOTIFICATIONS_DATABASE_URL as string,
          poolMax: 1,
          service: "test",
        }),
        PushModule,
      ],
    })
    class AppModule {}
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const { PUSH_TRANSPORTS } = await import("./push-transport");
    const transports = app.get<PushTransports>(PUSH_TRANSPORTS);
    await app.close();
    return Object.keys(transports);
  }

  it("sets up only the platforms that are configured", async () => {
    // The test environment configures Web Push (VAPID keys) and nothing else.
    expect(await platforms({})).toEqual(["web"]);
    vi.resetModules();
    expect(
      await platforms({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "" }),
    ).toEqual([]);
  });
});
