import { describe, expect, it } from "vitest";
import type { EmailTransport, OutgoingEmail } from "../email/email-transport";
import { EmailSinkSmsTransport, smsSinkAddress } from "./email-sink";

describe("EmailSinkSmsTransport", () => {
  it("delivers a text as a plain email to <digits>@sms.test, escaping the body", async () => {
    const sent: OutgoingEmail[] = [];
    const email: EmailTransport = {
      send: async (message) => {
        sent.push(message);
        return { providerMessageId: "m1" };
      },
    };
    const sink = new EmailSinkSmsTransport(email, "Boilerplate <no-reply@localhost>");
    const result = await sink.send("+14155550123", "Code <123456> & more", "key-1");
    expect(result).toEqual({ ok: true, providerMessageId: "m1" });
    expect(sent[0]).toMatchObject({
      to: "14155550123@sms.test",
      subject: "SMS to +14155550123",
      text: "Code <123456> & more",
      html: "<pre>Code &lt;123456> &amp; more</pre>",
      idempotencyKey: "key-1",
    });
    expect(smsSinkAddress("+34612345678")).toBe("34612345678@sms.test");
  });
});
