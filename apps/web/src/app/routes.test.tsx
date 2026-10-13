/**
 * The route files are thin: each exports its module's page and a translated title. This
 * checks every one against what it should serve.
 */
import en from "@repo/i18n/messages/en.json" with { type: "json" };
import { isValidElement, type ReactElement, Suspense } from "react";
import { describe, expect, it } from "vitest";
import { AssistantPage } from "@/modules/assistant";
import {
  CaptchaPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  SignInPage,
  SignUpPage,
  TwoFactorPage,
  VerifyEmailPage,
} from "@/modules/auth";
import { BillingPage } from "@/modules/billing";
import { DashboardPage } from "@/modules/dashboard";
import { InvitationPage } from "@/modules/invitations";
import {
  NotificationSettingsPage,
  NotificationsPage,
  UnsubscribePage,
} from "@/modules/notifications";
import { OAuthConsentPage } from "@/modules/oauth";
import { ProfileSettingsPage, SecuritySettingsPage, SettingsLayout } from "@/modules/settings";
import {
  WebhookEndpointPage,
  WorkspaceApiKeysPage,
  WorkspaceAuditPage,
  WorkspaceGeneralPage,
  WorkspaceMembersPage,
  WorkspaceWebhooksPage,
} from "@/modules/workspace";
import { renderHtml } from "../../test/next-server";
import * as assistant from "./(app)/assistant/page";
import * as dashboard from "./(app)/dashboard/page";
import * as invitation from "./(app)/invitations/[id]/page";
import * as notifications from "./(app)/notifications/page";
import * as consent from "./(app)/oauth/consent/page";
import * as apiKeys from "./(app)/settings/api-keys/page";
import * as audit from "./(app)/settings/audit/page";
import * as billing from "./(app)/settings/billing/page";
import SettingsRouteLayout from "./(app)/settings/layout";
import * as members from "./(app)/settings/members/page";
import * as notificationSettings from "./(app)/settings/notifications/page";
import * as profile from "./(app)/settings/page";
import * as security from "./(app)/settings/security/page";
import * as webhookEndpoint from "./(app)/settings/webhooks/[id]/page";
import * as webhooks from "./(app)/settings/webhooks/page";
import * as general from "./(app)/settings/workspace/page";
import * as forgotPassword from "./(auth)/forgot-password/page";
import AuthLayout from "./(auth)/layout";
import * as resetPassword from "./(auth)/reset-password/page";
import * as signIn from "./(auth)/sign-in/page";
import * as signUp from "./(auth)/sign-up/page";
import * as twoFactor from "./(auth)/two-factor/page";
import * as verifyEmail from "./(auth)/verify-email/page";
import * as captcha from "./captcha/page";
import * as privacy from "./privacy/page";
import * as terms from "./terms/page";
import * as unsubscribe from "./unsubscribe/page";

interface Route {
  generateMetadata: () => Promise<{ title?: unknown }>;
  default: unknown;
}

const pages: [string, Route, string, unknown][] = [
  ["/assistant", assistant, en.assistant.title, AssistantPage],
  ["/dashboard", dashboard, en.common.dashboard, DashboardPage],
  ["/notifications", notifications, en.notificationCenter.title, NotificationsPage],
  ["/settings/api-keys", apiKeys, en.workspace.apiKeys.title, WorkspaceApiKeysPage],
  ["/settings/audit", audit, en.workspace.audit.title, WorkspaceAuditPage],
  ["/settings/billing", billing, en.billing.title, BillingPage],
  ["/settings/members", members, en.workspace.members.title, WorkspaceMembersPage],
  [
    "/settings/notifications",
    notificationSettings,
    en.notificationSettings.title,
    NotificationSettingsPage,
  ],
  ["/settings", profile, en.settings.profile.title, ProfileSettingsPage],
  ["/settings/security", security, en.settings.security.title, SecuritySettingsPage],
  ["/settings/webhooks", webhooks, en.workspace.webhooks.title, WorkspaceWebhooksPage],
  ["/settings/workspace", general, en.workspace.general.title, WorkspaceGeneralPage],
  ["/forgot-password", forgotPassword, en.auth.forgotTitle, ForgotPasswordPage],
  ["/reset-password", resetPassword, en.auth.resetTitle, ResetPasswordPage],
  ["/sign-in", signIn, en.auth.signInTitle, SignInPage],
  ["/sign-up", signUp, en.auth.signUpTitle, SignUpPage],
  ["/two-factor", twoFactor, en.auth.twoFactorTitle, TwoFactorPage],
  ["/verify-email", verifyEmail, en.auth.verifyTitle, VerifyEmailPage],
];

/** What a route file's component renders, one level down. */
const rendered = async (component: unknown, props: object = {}) =>
  (await (component as (props: object) => ReactElement | Promise<ReactElement>)(
    props,
  )) as ReactElement<{
    children?: ReactElement;
    [key: string]: unknown;
  }>;

describe("route files", () => {
  it.each(pages)("%s serves its module's page, titled", async (_path, route, title, page) => {
    expect(route.default).toBe(page);
    expect(await route.generateMetadata()).toEqual({ title });
  });

  it("serves invitations and webhook endpoints by their id", async () => {
    const params = Promise.resolve({ id: "abc" });
    expect(await rendered(invitation.default, { params })).toEqual(<InvitationPage id="abc" />);
    expect(await rendered(webhookEndpoint.default, { params })).toEqual(
      <WebhookEndpointPage id="abc" />,
    );
    expect(await invitation.generateMetadata()).toEqual({ title: en.invitations.title });
    expect(await webhookEndpoint.generateMetadata()).toEqual({
      title: en.workspace.webhooks.title,
    });
  });

  it("renders pages that read the query string inside a Suspense boundary", async () => {
    for (const [route, page, title] of [
      [consent, OAuthConsentPage, en.oauth.title],
      [unsubscribe, UnsubscribePage, en.unsubscribe.title],
      [captcha, CaptchaPage, en.captcha.title],
    ] as const) {
      const element = await rendered(route.default);
      expect(element.type).toBe(Suspense);
      expect(isValidElement(element.props.children) && element.props.children.type).toBe(page);
      expect(await route.generateMetadata()).toEqual({ title });
    }
    const children = <p>step</p>;
    expect(AuthLayout({ children })).toEqual(<Suspense>{children}</Suspense>);
  });

  it("frames the settings pages", () => {
    const children = <p>tab</p>;
    expect(SettingsRouteLayout({ children })).toEqual(<SettingsLayout>{children}</SettingsLayout>);
  });

  it.each([
    [terms, en.legal.terms, en.legal.termsBody],
    [privacy, en.legal.privacy, en.legal.privacyBody],
  ])("renders the legal page %#", async (route, title, body) => {
    expect(await route.generateMetadata()).toEqual({ title });
    const html = await renderHtml(await rendered(route.default));
    expect(html).toContain(title);
    expect(html).toContain(body.slice(0, 40));
    expect(html).toContain("September 29, 2026");
  });
});
