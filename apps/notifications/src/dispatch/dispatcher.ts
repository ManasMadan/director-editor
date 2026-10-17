/**
 * Delivers one notification: claim the send in the delivery log, skip an address that
 * bounced or complained, render the email in the recipient's language, and send it.
 *
 * Each (job, recipient) is claimed in the delivery log first, so retries and
 * redelivered events never send twice. A failed send is recorded and thrown, so the
 * job's retry sends it again.
 */
import { Injectable } from "@nestjs/common";
import type { NotificationPayload } from "@repo/jobs";
import { asError, type I18n, InjectI18n } from "@repo/nest-common";
import { EmailChannel } from "../channels/email/email.channel";
import { DeliveryLog } from "./delivery-log";
import { DeliveryPolicy } from "./policy";
import { TemplateSource } from "./templates";

@Injectable()
export class Dispatcher {
  constructor(
    @InjectI18n() private readonly i18n: I18n,
    private readonly templates: TemplateSource,
    private readonly log: DeliveryLog,
    private readonly policy: DeliveryPolicy,
    private readonly email: EmailChannel,
  ) {}

  async dispatch(payload: NotificationPayload, idempotencyKey: string) {
    const { email, locale } = payload.to;
    const key = `${idempotencyKey}:email:${email}`;
    if (!(await this.log.claim(key, "email", payload.template, null))) {
      return;
    }
    try {
      if (await this.policy.isSuppressed("email", email)) {
        await this.log.finish(key, "suppressed");
        return;
      }
      const render = await this.templates.bind(payload);
      const t = await this.i18n.getTranslator(locale);
      const providerMessageId = await this.email.send(email, await render({ locale, t }), key);
      await this.log.finish(key, "sent", { providerMessageId });
    } catch (error) {
      await this.log.finish(key, "failed", { error: asError(error).message });
      throw error;
    }
  }
}
