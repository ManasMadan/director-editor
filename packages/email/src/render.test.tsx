import { render } from "@react-email/render";
import { bundledMessages, createI18n } from "@repo/i18n";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  AuthOtpEmail,
  authOtpSubject,
  DigestEmail,
  digestSubject,
  OrgInvitationEmail,
  orgInvitationSubject,
  PaymentFailedEmail,
  paymentFailedSubject,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
  TodoReminderEmail,
  todoReminderSubject,
  WebhookDisabledEmail,
  webhookDisabledSubject,
} from "./index";
import AuthOtpPreview from "./previews/auth-otp";
import DigestPreview from "./previews/digest";
import OrgInvitationPreview from "./previews/org-invitation";
import SecurityAlertPreview from "./previews/security-alert";
import TodoReminderPreview from "./previews/todo-reminder";
import WebhookDisabledPreview from "./previews/webhook-disabled";

const i18n = createI18n(bundledMessages);

describe("renderEmail", () => {
  it("renders subject, html and text for the OTP email", async () => {
    const email = await renderEmail(AuthOtpEmail, authOtpSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      otp: "482913",
      purpose: "email-verification",
      expiresInMinutes: 5,
    });
    expect(email.subject).toBe("Verify your email");
    expect(email.html).toContain("482913");
    expect(email.html).toContain('lang="en"');
    expect(email.text).toContain("This code expires in 5 minutes.");
  });

  it("localizes every part", async () => {
    const email = await renderEmail(AuthOtpEmail, authOtpSubject, {
      locale: "es",
      t: await i18n.getTranslator("es"),
      otp: "482913",
      purpose: "forget-password",
      expiresInMinutes: 1,
    });
    expect(email.subject).toBe("Restablece tu contraseña");
    expect(email.html).toContain('lang="es"');
    expect(email.text).toContain("Este código caduca en 1 minuto.");
  });
});

describe("security alert", () => {
  it("names the new address and links to security settings", async () => {
    const email = await renderEmail(SecurityAlertEmail, securityAlertSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      event: "email-changed",
      newEmail: "new@example.com",
      securityUrl: "https://app.example/settings/security",
    });
    expect(email.subject).toBe("Your email address was changed");
    expect(email.text).toContain("new@example.com");
    expect(email.html).toContain("https://app.example/settings/security");
  });
});

describe("todo reminder", () => {
  it('greets by name, or without one when there\'s none (never "Hi ,")', async () => {
    const render = async (name: string | null) =>
      renderEmail(TodoReminderEmail, todoReminderSubject, {
        locale: "en",
        t: await i18n.getTranslator("en"),
        name,
        title: "Water the plants",
      });
    // The HTML: plain text renders headings in capitals.
    expect((await render("Ada")).html).toContain("Hi Ada,");
    const unnamed = (await render(null)).html;
    expect(unnamed).toContain("Hi,");
    expect(unnamed).not.toContain("Hi ,");
  });
});

describe("the other templates", () => {
  it("invite to a workspace, with the link and when it expires", async () => {
    const email = await renderEmail(OrgInvitationEmail, orgInvitationSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      organizationName: "Acme",
      inviterName: "Ada",
      acceptUrl: "https://app.example/invitations/accept?id=1",
      expiresInDays: 7,
    });
    expect(email.subject).toBe("You're invited to a workspace on Boilerplate");
    expect(email.html).toContain("https://app.example/invitations/accept?id=1");
    expect(email.text).toContain("“Ada” invited you to collaborate in the workspace “Acme”.");
    expect(email.text).toContain("This invitation expires in 7 days.");
  });

  it("tell a workspace its payment failed, with the amount", async () => {
    const email = await renderEmail(PaymentFailedEmail, paymentFailedSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      organizationName: "Acme",
      amount: "$36.00",
      billingUrl: "https://app.example/settings/billing",
    });
    expect(email.subject).toBe("Payment failed for Acme");
    expect(email.text).toContain("The renewal payment of $36.00 for Acme");
    expect(email.html).toContain("https://app.example/settings/billing");
  });

  it("sum up the day, with a way to unsubscribe", async () => {
    const email = await renderEmail(DigestEmail, digestSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      items: [{ title: "Reminder", body: "Ship the demo" }],
      unsubscribeUrl: "https://app.example/unsubscribe?token=t",
    });
    expect(email.subject).toBe("Your daily summary");
    expect(email.text).toContain("1 update since your last summary.");
    expect(email.text).toContain("Ship the demo");
    expect(email.html).toContain("https://app.example/unsubscribe?token=t");
  });

  it("say which webhook endpoint was turned off", async () => {
    const email = await renderEmail(WebhookDisabledEmail, webhookDisabledSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      url: "https://example.com/hooks",
      settingsUrl: "https://app.example/settings/webhooks",
    });
    expect(email.subject).toBe("Webhook endpoint turned off: https://example.com/hooks");
    expect(email.html).toContain("https://app.example/settings/webhooks");
    expect(email.text).not.toContain("Unsubscribe");
  });

  it("name what was created in a security alert", async () => {
    const email = await renderEmail(SecurityAlertEmail, securityAlertSubject, {
      locale: "en",
      t: await i18n.getTranslator("en"),
      event: "api-key-created",
      label: "CI deploys",
      securityUrl: "https://app.example/settings/security",
    });
    expect(email.subject).toBe("An API key was created in your workspace");
    expect(email.text).toContain("An admin created the API key “CI deploys”.");
  });
});

describe("previews", () => {
  it.each([
    ["auth-otp", AuthOtpPreview],
    ["digest", DigestPreview],
    ["org-invitation", OrgInvitationPreview],
    ["security-alert", SecurityAlertPreview],
    ["todo-reminder", TodoReminderPreview],
    ["webhook-disabled", WebhookDisabledPreview],
  ])("%s renders", async (_, Preview) => {
    const html = await render(createElement(Preview));
    expect(html).toContain('lang="en"');
    expect(html).toContain("Boilerplate");
  });
});
