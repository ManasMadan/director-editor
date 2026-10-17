/**
 * What each notification template renders to. Every notification is an email: sign-in
 * codes and security alerts, which always go out.
 *
 * Templates are defined in code today and reached only through `TemplateSource`, so
 * they can later be stored in the database (editable copy, per-tenant branding)
 * without touching the dispatcher: implement `TemplateSource` over a table, cache it
 * in Redis, and bind it instead of `CodeTemplateSource` in notifications.module.ts.
 *
 * Adding a template: add its payload to `notificationPayload` in packages/jobs, its
 * copy to packages/i18n, an email component to packages/email, then an entry below. The
 * `satisfies` clause makes a missing template a compile error.
 */
import { Injectable } from "@nestjs/common";
import {
  AuthOtpEmail,
  authOtpSubject,
  type RenderedEmail,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
} from "@repo/email";
import type { Locale, Translator } from "@repo/i18n";
import type { NotificationPayload, NotificationTemplate } from "@repo/jobs";

type PayloadOf<T extends NotificationTemplate> = Extract<NotificationPayload, { template: T }>;

interface RenderContext {
  locale: Locale;
  t: Translator;
}

type TemplateDefinition<T extends NotificationTemplate> = (
  payload: PayloadOf<T>,
  context: RenderContext,
) => Promise<RenderedEmail>;

type TemplateRegistry = { [T in NotificationTemplate]: TemplateDefinition<T> };

const templates = {
  "auth.otp": (payload, { locale, t }) =>
    renderEmail(AuthOtpEmail, authOtpSubject, { locale, t, ...payload.data }),
  "auth.security-alert": (payload, { locale, t }) =>
    renderEmail(SecurityAlertEmail, securityAlertSubject, { locale, t, ...payload.data }),
} satisfies TemplateRegistry;

/** A template with its payload applied: the email it renders to, in a language. */
export type BoundTemplate = (context: RenderContext) => Promise<RenderedEmail>;

export abstract class TemplateSource {
  abstract bind(payload: NotificationPayload): Promise<BoundTemplate>;
}

/**
 * The payload's own template, bound to it. Through the registry's mapped type TypeScript
 * pairs a template with its payload, which a lookup on the union can't.
 */
function bindOwn<T extends NotificationTemplate>(
  registry: TemplateRegistry,
  template: T,
  payload: PayloadOf<T>,
): BoundTemplate {
  const render: TemplateDefinition<T> = registry[template];
  return (context) => render(payload, context);
}

@Injectable()
export class CodeTemplateSource extends TemplateSource {
  async bind(payload: NotificationPayload): Promise<BoundTemplate> {
    return bindOwn(templates, payload.template, payload);
  }
}
