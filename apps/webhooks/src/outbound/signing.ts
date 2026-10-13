/**
 * Standard Webhooks (standardwebhooks.com) signing, through its reference library, so
 * customers can verify our deliveries with any of its libraries:
 *
 *   webhook-id: <message id>           the same on every retry (their idempotency key)
 *   webhook-timestamp: <unix seconds>   receivers reject old ones (replay protection)
 *   webhook-signature: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>
 *
 * Right after a rotation there are two secrets, and the header carries a signature for
 * each, space-separated (the standard's way): a receiver with either one accepts it.
 * Secrets come from `newWebhookSecret` (@repo/nest-common).
 */
import { Webhook } from "standardwebhooks";

/** The headers for one delivery attempt, signed with every secret given (newest first). */
export function signatureHeaders(
  secrets: readonly string[],
  messageId: string,
  body: string,
  now = Date.now(),
) {
  // Whole seconds, as the header carries them, so the signature covers what's sent.
  const timestamp = Math.floor(now / 1000);
  const at = new Date(timestamp * 1000);
  return {
    "webhook-id": messageId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": secrets
      .map((secret) => new Webhook(secret).sign(messageId, at, body))
      .join(" "),
  };
}
