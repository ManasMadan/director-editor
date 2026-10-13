/**
 * Stalwart's webhook, as data: its signature, its events, and which of them mean an
 * address must not be emailed again. The route (stalwart.routes.ts) stores and acts on
 * them; everything here is pure so it's tested against real payloads.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { MINUTE_MS } from "@repo/contracts/time";
import * as z from "zod";

/** Stalwart's discardAfter default is five minutes; the rest is room for clock skew. */
const TOLERANCE_MS = 10 * MINUTE_MS;

const stalwartEvent = z.object({
  id: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type StalwartEvent = z.infer<typeof stalwartEvent>;
export const stalwartBatch = z.object({ events: z.array(stalwartEvent).min(1) });

/**
 * Whether the header is the body's signature under any of the secrets (several while a
 * rotation is in progress), compared in constant time.
 */
export function verifySignature(secrets: readonly string[], body: string, header: string) {
  const actual = Buffer.from(header, "base64");
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(body).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** Whether every event in the batch was created within the tolerance of `now`. */
export function isFresh(events: readonly StalwartEvent[], now: number) {
  return events.every((event) => Math.abs(now - Date.parse(event.createdAt)) <= TOLERANCE_MS);
}

/**
 * The key an event is stored under once. Not Stalwart's `id`: that's a per-process
 * counter assigned each time a batch is serialized, so a retried batch carries new ids
 * for the same events. Everything else in the event repeats exactly, so it's hashed.
 */
export function eventKey(event: StalwartEvent) {
  return createHash("sha256")
    .update(JSON.stringify([event.type, event.createdAt, event.data]))
    .digest("hex");
}

// How Stalwart describes a failure (its queue Error's Display, smtp-proto's Response).
// Without an enhanced code from the remote server the code reads 0.0.0.
const SMTP_REPLY =
  /^Unexpected response for (.+?): Code: (\d{3}), Enhanced code: (\d+)\.(\d+)\.(\d+), /;
const DOMAIN_GONE = /^DNS lookup failed: (Domain not found|Domain does not accept messages)/;

/**
 * Whether a permanent failure means the address itself can't receive mail. Other
 * permanent failures (a spam policy, a message too large, TLS or MTA-STS trouble, a
 * problem with our own sender address) are about this message or our server, and
 * suppressing the recipient for them would silently cut off people whose mailbox is fine.
 */
export function isHardBounce(details: string) {
  if (DOMAIN_GONE.test(details)) {
    return true;
  }
  const reply = SMTP_REPLY.exec(details);
  if (!reply) {
    return false;
  }
  const [, command = "", code = "", status, subject, detail] = reply;
  // RFC 3463: 5.1.x is a bad destination address (except 5.1.7 and 5.1.8, which are
  // about the sender), 5.2.1 a disabled mailbox. 5.2.2 (mailbox full) passes with time.
  if (status !== "0") {
    if (status !== "5") {
      return false;
    }
    if (subject === "1") {
      return detail !== "7" && detail !== "8";
    }
    return subject === "2" && detail === "1";
  }
  // A server without enhanced codes: only a recipient refused as unknown (RFC 5321).
  return command.startsWith("RCPT TO") && ["550", "551", "553"].includes(code);
}

/** The address to suppress for an event, or null for events we only record. */
export function bouncedAddress(event: StalwartEvent) {
  if (event.type !== "delivery.dsn-perm-fail") {
    return null;
  }
  const { to, details } = event.data;
  if (typeof details !== "string" || !isHardBounce(details)) {
    return null;
  }
  const address = z.email().safeParse(to);
  return address.success ? address.data : null;
}
