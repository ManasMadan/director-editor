/**
 * Email delivery behind one interface. Production submits to our own Stalwart mail
 * server over authenticated SMTP with TLS; locally the same transport sends to Mailpit.
 * Any other server that speaks SMTP needs only a different SMTP_URL. A provider with
 * its own API would be a class implementing `EmailTransport`, chosen in email.module.ts.
 */
import type { RenderedEmail } from "@repo/email";
import nodemailer from "nodemailer";

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  from: string;
  /** Extra headers, e.g. List-Unsubscribe for emails the recipient can opt out of. */
  headers?: Record<string, string>;
  /** Lets receiving providers and our retries dedupe the same logical message. */
  idempotencyKey: string;
}

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<{ providerMessageId: string }>;
}

export const EMAIL_TRANSPORT = Symbol("EMAIL_TRANSPORT");

export class SmtpTransport implements EmailTransport {
  private readonly transporter;

  /**
   * `timeoutMs` bounds connecting, the server's greeting and any silence on the socket:
   * nodemailer's defaults (two minutes to connect, ten of silence) would hold a
   * delivery, and its job, that long on a stuck server.
   */
  constructor(url: string, timeoutMs = 30_000) {
    this.transporter = nodemailer.createTransport({
      url,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
  }

  async send(email: OutgoingEmail) {
    const info = await this.transporter.sendMail({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: email.headers,
      messageId: `<${email.idempotencyKey}@notifications>`,
    });
    return { providerMessageId: info.messageId };
  }
}
