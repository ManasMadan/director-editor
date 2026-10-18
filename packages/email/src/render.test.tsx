import { render } from "@react-email/render";
import { bundledMessages, createI18n } from "@repo/i18n";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  AuthOtpEmail,
  authOtpSubject,
  renderEmail,
  SecurityAlertEmail,
  securityAlertSubject,
} from "./index";
import AuthOtpPreview from "./previews/auth-otp";
import SecurityAlertPreview from "./previews/security-alert";

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

describe("previews", () => {
  it.each([
    ["auth-otp", AuthOtpPreview],
    ["security-alert", SecurityAlertPreview],
  ])("%s renders", async (_, Preview) => {
    const html = await render(createElement(Preview));
    expect(html).toContain('lang="en"');
    expect(html).toContain("Director");
  });
});
