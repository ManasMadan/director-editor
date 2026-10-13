import type { PinoLogger } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { SmsChannel } from "./sms.channel";

describe("SmsChannel", () => {
  it("is off, and refuses to text, without a provider", async () => {
    const channel = new SmsChannel(null, { info: () => undefined } as unknown as PinoLogger);
    expect(channel.enabled).toBe(false);
    expect(await channel.send("+14155550123", "code", "key-1")).toEqual({
      ok: false,
      permanent: true,
      suppress: null,
      error: "no SMS provider configured",
    });
  });
});
