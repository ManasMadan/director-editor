import { Inject, Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import { SMS_TRANSPORT, type SmsResult, type SmsTransport } from "./sms-transport";

@Injectable()
export class SmsChannel {
  constructor(
    @Inject(SMS_TRANSPORT) private readonly transport: SmsTransport | null,
    @InjectPinoLogger(SmsChannel.name) private readonly log: PinoLogger,
  ) {}

  /** Whether texts can be sent at all (a provider is configured). */
  get enabled() {
    return this.transport !== null;
  }

  async send(to: string, body: string, idempotencyKey: string): Promise<SmsResult> {
    if (!this.transport) {
      return { ok: false, permanent: true, suppress: null, error: "no SMS provider configured" };
    }
    const result = await this.transport.send(to, body, idempotencyKey);
    // Never log the body or the full number: texts carry codes, numbers are personal data.
    this.log.info(
      {
        to: `…${to.slice(-2)}`,
        idempotencyKey,
        ...(result.ok ? { providerMessageId: result.providerMessageId } : { error: result.error }),
      },
      result.ok ? "text sent" : "text failed",
    );
    return result;
  }
}
