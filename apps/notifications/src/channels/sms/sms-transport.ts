/**
 * Text messages behind one interface. Twilio in production; locally, texts are delivered
 * as emails to Mailpit (EmailSinkSmsTransport), so codes can be read there and by tests.
 * To use another provider (Vonage, MessageBird, AWS SNS), implement `SmsTransport` and
 * pick it in sms.module.ts.
 */
export type SmsResult =
  | { ok: true; providerMessageId: string }
  /**
   * `permanent`: retrying won't help. `suppress`: never text this number again, because
   * its owner opted out (replied STOP) or it can't receive texts.
   */
  | {
      ok: false;
      permanent: boolean;
      suppress: "unsubscribe" | "invalid" | null;
      error: string;
    };

export interface SmsTransport {
  send(to: string, body: string, idempotencyKey: string): Promise<SmsResult>;
}

export const SMS_TRANSPORT = Symbol("SMS_TRANSPORT");
