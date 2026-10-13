/**
 * Renders an email template to the three parts every provider needs.
 *
 *   const email = await renderEmail(AuthOtpEmail, authOtpSubject, props);
 *   // { subject, html, text }
 *
 * The plain-text part is generated from the same component, so both always match.
 * Preview every template in the browser with `bun run --filter @repo/email dev`.
 */
import { render } from "@react-email/render";
import type { ComponentType } from "react";
import { createElement } from "react";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail<P extends object>(
  Template: ComponentType<P>,
  subject: (props: P) => string,
  props: P,
): Promise<RenderedEmail> {
  const element = createElement(Template, props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: subject(props), html, text };
}

export {
  authOtpSubject,
  default as AuthOtpEmail,
} from "./templates/auth-otp";
export { default as DigestEmail, digestSubject } from "./templates/digest";
export {
  default as OrgInvitationEmail,
  orgInvitationSubject,
} from "./templates/org-invitation";
export {
  default as PaymentFailedEmail,
  paymentFailedSubject,
} from "./templates/payment-failed";
export {
  default as SecurityAlertEmail,
  securityAlertSubject,
} from "./templates/security-alert";
export {
  default as TodoReminderEmail,
  todoReminderSubject,
} from "./templates/todo-reminder";
export {
  default as WebhookDisabledEmail,
  webhookDisabledSubject,
} from "./templates/webhook-disabled";
