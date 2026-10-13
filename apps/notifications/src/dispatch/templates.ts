/**
 * What each notification template is (its category) and what it renders to, per channel.
 * A channel a template doesn't render to is never used for it; a category's channels
 * (packages/contracts notifications) cap what users can receive and turn off.
 *
 * Templates are defined in code today and reached only through `TemplateSource`, so
 * they can later be stored in the database (editable copy, per-tenant branding)
 * without touching the dispatcher: implement `TemplateSource` over a table, cache it
 * in Redis, and bind it instead of `CodeTemplateSource` in notifications.module.ts.
 *
 * Adding a template: add its payload to `notificationPayload` in packages/jobs, its
 * copy to packages/i18n, an email component to packages/email if it emails, then an
 * entry below. The `satisfies` clause makes a missing template a compile error.
 */
import { Injectable } from "@nestjs/common";
import type { OrgId } from "@repo/contracts/ids";
import { formatMoney } from "@repo/contracts/money";
import type { InAppNotificationType, NotificationCategory } from "@repo/contracts/notifications";
import {
  AuthOtpEmail,
  authOtpSubject,
  OrgInvitationEmail,
  orgInvitationSubject,
  PaymentFailedEmail,
  paymentFailedSubject,
  type RenderedEmail,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
  TodoReminderEmail,
  todoReminderSubject,
  WebhookDisabledEmail,
  webhookDisabledSubject,
} from "@repo/email";
import type { Translator } from "@repo/i18n";
import type { NotificationPayload, NotificationTemplate } from "@repo/jobs";
import { env } from "../env";
import type { Recipient } from "./recipients";

type PayloadOf<T extends NotificationTemplate> = Extract<NotificationPayload, { template: T }>;

export interface RenderContext {
  recipient: Recipient;
  t: Translator;
  /** Present when the recipient may opt out of this email (mutable category, known user). */
  unsubscribeUrl?: string | undefined;
  /** The notification being delivered (for deferring a channel to later). */
  payload: NotificationPayload;
}

/** An in-app notification: rendered by the app from `notification.<type>` copy. */
export interface InAppMessage {
  type: InAppNotificationType;
  data: Record<string, string>;
  /** A path on the web app. */
  link: string;
  orgId?: OrgId;
}

interface TemplateDefinition<T extends NotificationTemplate> {
  category: NotificationCategory;
  email?: (payload: PayloadOf<T>, context: RenderContext) => Promise<RenderedEmail>;
  inApp?: (payload: PayloadOf<T>, context: RenderContext) => InAppMessage;
  push?: (
    payload: PayloadOf<T>,
    context: RenderContext,
  ) => { title: string; body: string; link?: string };
  /** A text message: short, plain, no links a phisher could imitate. */
  sms?: (payload: PayloadOf<T>, context: RenderContext) => string;
}

type TemplateRegistry = { [T in NotificationTemplate]: TemplateDefinition<T> };

const url = (path: string) => new URL(path, env.WEB_URL).toString();

const templates = {
  "auth.otp": {
    category: "security",
    email: (payload, { recipient, t }) =>
      renderEmail(AuthOtpEmail, authOtpSubject, { locale: recipient.locale, t, ...payload.data }),
  },
  "auth.phone-code": {
    category: "security",
    sms: (payload, { t }) =>
      t("sms.phoneCode", {
        code: payload.data.code,
        expiresInMinutes: payload.data.expiresInMinutes,
      }),
  },
  "auth.security-alert": {
    category: "security",
    email: (payload, { recipient, t }) =>
      renderEmail(SecurityAlertEmail, securityAlertSubject, {
        locale: recipient.locale,
        t,
        ...payload.data,
      }),
    sms: (payload, { t }) => t(`sms.securityAlert.${payload.data.event}`),
  },
  "org.invitation": {
    category: "invitations",
    email: (payload, { recipient, t }) =>
      renderEmail(OrgInvitationEmail, orgInvitationSubject, {
        locale: recipient.locale,
        t,
        ...payload.data,
      }),
  },
  "workspace.access-created": {
    category: "security",
    email: (payload, { recipient, t }) =>
      renderEmail(SecurityAlertEmail, securityAlertSubject, {
        locale: recipient.locale,
        t,
        event: payload.data.kind === "api-key" ? "api-key-created" : "webhook-endpoint-created",
        label: payload.data.label,
        securityUrl: url(
          payload.data.kind === "api-key" ? "/settings/api-keys" : "/settings/webhooks",
        ),
      }),
  },
  "webhooks.endpoint-disabled": {
    category: "workspace",
    inApp: (payload) => ({
      type: "webhooks.endpoint-disabled",
      data: { endpointId: payload.data.endpointId, url: payload.data.url },
      link: `/settings/webhooks/${payload.data.endpointId}`,
      orgId: payload.to.orgId,
    }),
    email: (payload, { recipient, t, unsubscribeUrl }) =>
      renderEmail(WebhookDisabledEmail, webhookDisabledSubject, {
        locale: recipient.locale,
        t,
        url: payload.data.url,
        settingsUrl: url(`/settings/webhooks/${payload.data.endpointId}`),
        unsubscribeUrl,
      }),
    push: (payload, { t }) => ({
      title: t("notification.webhooks.endpoint-disabled.title"),
      body: t("notification.webhooks.endpoint-disabled.body", { url: payload.data.url }),
      link: `/settings/webhooks/${payload.data.endpointId}`,
    }),
  },
  "billing.payment-failed": {
    category: "billing",
    inApp: (payload, { recipient }) => ({
      type: "billing.payment-failed",
      data: { amount: formatMoney(payload.data, recipient.locale) },
      link: "/settings/billing",
      orgId: payload.to.orgId,
    }),
    email: (payload, { recipient, t }) =>
      renderEmail(PaymentFailedEmail, paymentFailedSubject, {
        locale: recipient.locale,
        t,
        organizationName: payload.data.organizationName,
        amount: formatMoney(payload.data, recipient.locale),
        billingUrl: payload.data.billingUrl,
      }),
  },
  "todo.reminder": {
    category: "activity",
    inApp: (payload) => ({
      type: "todo.reminder",
      data: { todoId: payload.data.todoId, title: payload.data.title },
      link: "/dashboard",
    }),
    email: (payload, { recipient, t, unsubscribeUrl }) =>
      renderEmail(TodoReminderEmail, todoReminderSubject, {
        locale: recipient.locale,
        t,
        name: recipient.name?.trim() || null,
        title: payload.data.title,
        unsubscribeUrl,
      }),
    push: (payload, { t }) => ({
      title: t("notification.todo.reminder.title"),
      body: t("notification.todo.reminder.body", { title: payload.data.title }),
      link: "/dashboard",
    }),
  },
} satisfies TemplateRegistry;

/** A template with its payload applied: what the dispatcher works with. */
export interface BoundTemplate {
  category: NotificationCategory;
  email?: (context: RenderContext) => Promise<RenderedEmail>;
  inApp?: (context: RenderContext) => InAppMessage;
  push?: (context: RenderContext) => { title: string; body: string; link?: string };
  sms?: (context: RenderContext) => string;
}

/** Pairs a definition with its payload, so the dispatcher renders without knowing which. */
function bind<T extends NotificationTemplate>(
  definition: TemplateDefinition<T>,
  payload: PayloadOf<T>,
): BoundTemplate {
  const { email, inApp, push, sms } = definition;
  return {
    category: definition.category,
    ...(email && { email: (context: RenderContext) => email(payload, context) }),
    ...(inApp && { inApp: (context: RenderContext) => inApp(payload, context) }),
    ...(push && { push: (context: RenderContext) => push(payload, context) }),
    ...(sms && { sms: (context: RenderContext) => sms(payload, context) }),
  };
}

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
  return bind(registry[template], payload);
}

@Injectable()
export class CodeTemplateSource extends TemplateSource {
  async bind(payload: NotificationPayload): Promise<BoundTemplate> {
    return bindOwn(templates, payload.template, payload);
  }
}
