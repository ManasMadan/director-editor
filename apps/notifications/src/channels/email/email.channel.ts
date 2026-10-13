import { Inject, Injectable } from "@nestjs/common";
import type { RenderedEmail } from "@repo/email";
import { InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import { env } from "../../env";
import { EMAIL_TRANSPORT, type EmailTransport } from "./email-transport";

@Injectable()
export class EmailChannel {
  constructor(
    @Inject(EMAIL_TRANSPORT) private readonly transport: EmailTransport,
    @InjectPinoLogger(EmailChannel.name) private readonly log: PinoLogger,
  ) {}

  async send(
    to: string,
    email: RenderedEmail,
    idempotencyKey: string,
    headers?: Record<string, string>,
  ) {
    const { providerMessageId } = await this.transport.send({
      ...email,
      to,
      from: env.EMAIL_FROM,
      idempotencyKey,
      ...(headers && { headers }),
    });
    // Never log the body: it can contain one-time codes.
    this.log.info({ providerMessageId, subject: email.subject, idempotencyKey }, "email sent");
    return providerMessageId;
  }
}
