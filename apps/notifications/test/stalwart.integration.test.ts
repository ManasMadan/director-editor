/**
 * The service's own SMTP transport against the compose `stalwart` service (`bun run
 * db:up:mail`), the way production sends: authenticated submission over TLS, then
 * Stalwart's delivery (relayed to Mailpit locally, DKIM-signed on the way).
 *
 * Skipped unless STALWART_SMTP_URL is set, e.g.
 * smtps://no-reply:no-reply-password@localhost:51465?tls.rejectUnauthorized=false
 * (the container's certificate is self-signed; production refuses that setting).
 */
import { randomUUID } from "node:crypto";
import { eventually } from "@repo/testing/eventually";
import { describe, expect, it } from "vitest";
import { SmtpTransport } from "../src/channels/email/email-transport";

const SMTP_URL = process.env.STALWART_SMTP_URL;
// The Mailpit Stalwart relays to: compose's. In CI that isn't the job's own Mailpit.
const MAILPIT =
  process.env.STALWART_MAILPIT_URL ?? process.env.MAILPIT_URL ?? "http://localhost:58025";

const email = (to: string) => ({
  from: "Boilerplate <no-reply@boilerplate.test>",
  to,
  subject: "Stalwart submission",
  html: "<p>Sent through Stalwart</p>",
  text: "Sent through Stalwart",
  headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  idempotencyKey: randomUUID(),
});

describe.skipIf(!SMTP_URL)("SMTP submission to Stalwart", () => {
  it("submits with the account's credentials over TLS and the message is delivered", async () => {
    const to = `stalwart-${randomUUID()}@example.org`;
    const outgoing = email(to);
    const { providerMessageId } = await new SmtpTransport(SMTP_URL as string).send(outgoing);
    expect(providerMessageId).toBe(`<${outgoing.idempotencyKey}@notifications>`);

    const id = await eventually(
      async () => {
        const response = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
        );
        return ((await response.json()) as { messages: { ID: string }[] }).messages[0]?.ID;
      },
      (found) => found !== undefined,
      { timeout: 20_000, interval: 250 },
    );
    const headers = (await (
      await fetch(`${MAILPIT}/api/v1/message/${id}/headers`)
    ).json()) as Record<string, string[]>;
    // Signed by Stalwart for our domain, and our own headers kept.
    expect(headers["Dkim-Signature"]?.join(" ")).toMatch(/d=boilerplate\.test/);
    expect(headers["List-Unsubscribe-Post"]).toEqual(["List-Unsubscribe=One-Click"]);
    expect(headers["Message-Id"]).toEqual([`<${outgoing.idempotencyKey}@notifications>`]);
  });

  it("fails the send when the password is wrong, so the job is retried", async () => {
    const wrong = new URL(SMTP_URL as string);
    wrong.password = "not-the-password";
    await expect(
      new SmtpTransport(wrong.toString()).send(email(`nobody-${randomUUID()}@example.org`)),
    ).rejects.toThrow(/535|auth/i);
  });
});
