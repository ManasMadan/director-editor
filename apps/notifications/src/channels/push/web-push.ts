/**
 * Web Push (browsers) with VAPID. The device "token" is the browser's PushSubscription
 * (endpoint + keys) as JSON. The web-push library encrypts the payload (RFC 8291) and
 * signs the VAPID header; the request itself goes through fetch, after checking that the
 * endpoint is a browser push service (the subscription came from a client).
 */
import { isWebPushEndpoint } from "@repo/contracts/notifications";
import { DAY_S, PROVIDER_TIMEOUT_MS } from "@repo/contracts/time";
import { asError } from "@repo/nest-common";
import webPush from "web-push";
import * as z from "zod";
import type { PushMessage, PushResult, PushTransport } from "./push-transport";

/** A browser's PushSubscription as it stored it (PushSubscription.toJSON()). */
const subscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact for push services, required by VAPID. */
  subject: string;
  /** Test hook: an origin (e.g. a local server) accepted besides the browsers' push services. */
  testOrigin?: string | undefined;
}

export class WebPushTransport implements PushTransport {
  constructor(private readonly config: WebPushConfig) {}

  async send(token: string, message: PushMessage): Promise<PushResult> {
    let stored: unknown;
    try {
      stored = JSON.parse(token);
    } catch {
      return { ok: false, gone: true, error: "stored subscription isn't JSON" };
    }
    const parsed = subscriptionSchema.safeParse(stored);
    if (!parsed.success) {
      return { ok: false, gone: true, error: "stored subscription is malformed" };
    }
    const subscription: webPush.PushSubscription = parsed.data;
    const endpoint = subscription.endpoint;
    const allowed =
      isWebPushEndpoint(endpoint) ||
      (this.config.testOrigin !== undefined && endpoint.startsWith(`${this.config.testOrigin}/`));
    if (!allowed) {
      return { ok: false, gone: true, error: "not a browser push service" };
    }

    const request = webPush.generateRequestDetails(
      subscription,
      JSON.stringify({
        title: message.title,
        body: message.body,
        link: message.link,
        tag: message.collapseKey,
      }),
      {
        vapidDetails: {
          subject: this.config.subject,
          publicKey: this.config.publicKey,
          privateKey: this.config.privateKey,
        },
        TTL: DAY_S,
        ...(message.collapseKey && { topic: message.collapseKey.replaceAll(/[^\w-]/g, "") }),
      },
    );
    let response: Response;
    try {
      response = await fetch(request.endpoint, {
        method: request.method,
        headers: request.headers as Record<string, string>,
        // The encrypted payload, as bytes fetch accepts (a Node Buffer isn't typed as one).
        body: new Uint8Array(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, gone: false, error: `Web Push: ${asError(error).message}` };
    }
    if (response.ok) {
      return { ok: true, providerMessageId: response.headers.get("location") ?? undefined };
    }
    const text = await response.text();
    return {
      ok: false,
      // 404/410: the subscription expired or the user revoked permission.
      gone: response.status === 404 || response.status === 410,
      error: `Web Push ${response.status}: ${text.slice(0, 200)}`,
    };
  }
}
