import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioTransport } from "./twilio";

afterEach(() => vi.restoreAllMocks());

describe("TwilioTransport", () => {
  it("talks to Twilio's API unless told otherwise", async () => {
    // Twilio can't be reached from a test: fetch answers for it, and records where it went.
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return Response.json({ sid: "SM1" }, { status: 201 });
    });
    const twilio = new TwilioTransport({ accountSid: "AC1", authToken: "t", from: "+15005550006" });
    expect(await twilio.send("+14155550123", "hi")).toEqual({ ok: true, providerMessageId: "SM1" });
    expect(calls).toEqual(["https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json"]);
  });
});
