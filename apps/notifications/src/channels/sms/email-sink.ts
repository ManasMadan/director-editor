/**
 * Development only: delivers each text as a plain email to `<digits>@sms.test`, so local
 * texts show up in Mailpit next to the emails (and e2e tests read codes from there).
 * env.ts refuses it in production.
 */
import type { EmailTransport } from "../email/email-transport";
import type { SmsResult, SmsTransport } from "./sms-transport";

export const smsSinkAddress = (phone: string) => `${phone.replace(/^\+/, "")}@sms.test`;

export class EmailSinkSmsTransport implements SmsTransport {
  constructor(
    private readonly email: EmailTransport,
    private readonly from: string,
  ) {}

  async send(to: string, body: string, idempotencyKey: string): Promise<SmsResult> {
    const { providerMessageId } = await this.email.send({
      to: smsSinkAddress(to),
      from: this.from,
      subject: `SMS to ${to}`,
      text: body,
      html: `<pre>${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`,
      idempotencyKey,
    });
    return { ok: true, providerMessageId };
  }
}
