/**
 * A local stand-in for Twilio's Messages API: checks basic auth and the form fields, and
 * answers like Twilio does for its documented error cases, chosen by the number texted.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const TWILIO_NUMBERS = {
  optedOut: "+15005550004", // 21610: replied STOP
  invalid: "+15005550001", // 21211: not a valid number
  landline: "+15005550009", // 21614: not a mobile
  regionBlocked: "+15005550408", // 21408: permission to send to this region is off
  flaky: "+15005550500", // 500 until recover()
};

interface Texted {
  to: string;
  from: string;
  body: string;
}

/** The numbers Twilio always refuses, with its status, error code and message. */
const REFUSED: Record<string, readonly [number, number, string]> = {
  [TWILIO_NUMBERS.optedOut]: [400, 21610, "Attempt to send to unsubscribed recipient"],
  [TWILIO_NUMBERS.invalid]: [400, 21211, "Invalid 'To' Phone Number"],
  [TWILIO_NUMBERS.landline]: [400, 21614, "'To' number is not a valid mobile number"],
  [TWILIO_NUMBERS.regionBlocked]: [
    400,
    21408,
    "Permission to send an SMS has not been enabled for the region",
  ],
};

export async function startFakeTwilio() {
  const accountSid = `AC${randomBytes(16).toString("hex")}`;
  const authToken = randomBytes(16).toString("hex");
  const from = "+15005550006";
  const messagingService = `MG${randomBytes(16).toString("hex")}`;
  const texted: Texted[] = [];
  let healthy = false;

  /** Twilio's error for a message to `to`, as [status, code, message], or undefined. */
  const refusal = (to: string) => {
    if (to === TWILIO_NUMBERS.flaky && !healthy) {
      return [500, 20500, "Internal Server Error"] as const;
    }
    return REFUSED[to];
  };

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const expectedAuth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
    if (request.url !== `/2010-04-01/Accounts/${accountSid}/Messages.json`) {
      return reply(404, { code: 20404, message: "not found" });
    }
    if (request.headers.authorization !== expectedAuth) {
      return reply(401, { code: 20003, message: "Authenticate" });
    }
    const to = form.get("To") ?? "";
    const body = form.get("Body") ?? "";
    // A sender number, or a Messaging Service that picks one.
    const sender = form.get("From") ?? form.get("MessagingServiceSid");
    if ((sender !== from && sender !== messagingService) || !body) {
      return reply(400, { code: 21602, message: "bad" });
    }
    const failure = refusal(to);
    if (failure) {
      return reply(failure[0], { code: failure[1], message: failure[2] });
    }
    texted.push({ to, from: sender, body });
    reply(201, { sid: `SM${randomBytes(16).toString("hex")}`, status: "queued" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    texted,
    messagingService,
    to: (phone: string) => texted.filter((message) => message.to === phone),
    env: {
      SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: accountSid,
      TWILIO_AUTH_TOKEN: authToken,
      TWILIO_FROM: from,
      TWILIO_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    recover() {
      healthy = true;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
export type FakeTwilio = Awaited<ReturnType<typeof startFakeTwilio>>;
