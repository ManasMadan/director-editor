/**
 * Twilio's Messages API (one form-encoded POST, basic auth). `from` is a sender number in
 * E.164, or a Messaging Service SID ("MG...") to let Twilio pick the sender per country.
 */

import { PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { asError } from "@repo/nest-common";
import * as z from "zod";
import type { SmsResult, SmsTransport } from "./sms-transport";

// Twilio's answer, success or error; anything else reads as an error without details.
const twilioResult = z
  .object({
    sid: z.string().optional(),
    code: z.number().optional(),
    message: z.string().optional(),
  })
  .catch({});

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string;
  /** Overridable for tests; Twilio's API by default. */
  apiUrl?: string | undefined;
}

// Twilio error codes that mean the number will never take our texts.
const SUPPRESS: Record<number, "unsubscribe" | "invalid"> = {
  21610: "unsubscribe", // the recipient replied STOP
  21211: "invalid", // not a valid phone number
  21614: "invalid", // not a mobile number
};

export class TwilioTransport implements SmsTransport {
  constructor(private readonly config: TwilioConfig) {}

  async send(to: string, body: string): Promise<SmsResult> {
    const { accountSid, authToken, from } = this.config;
    const apiUrl = this.config.apiUrl ?? "https://api.twilio.com";
    const form = new URLSearchParams({ To: to, Body: body });
    form.set(from.startsWith("MG") ? "MessagingServiceSid" : "From", from);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        permanent: false,
        suppress: null,
        error: `Twilio: ${asError(error).message}`,
      };
    }
    const result = twilioResult.parse(await response.json().catch(() => ({})));
    if (response.ok && result.sid) {
      return { ok: true, providerMessageId: result.sid };
    }
    const code = result.code ?? 0;
    return {
      ok: false,
      // 4xx (other than rate limiting) won't change on retry; 5xx and 429 might.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      suppress: SUPPRESS[code] ?? null,
      error: `Twilio ${response.status} ${code}: ${result.message ?? "unknown error"}`,
    };
  }
}
