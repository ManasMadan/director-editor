/**
 * The route files are thin: each exports its module's page and a translated title. This
 * checks every one against what it should serve.
 */
import en from "@repo/i18n/messages/en.json" with { type: "json" };
import { type ReactElement, Suspense } from "react";
import { describe, expect, it } from "vitest";
import {
  ForgotPasswordPage,
  ResetPasswordPage,
  SignInPage,
  SignUpPage,
  TwoFactorPage,
  VerifyEmailPage,
} from "@/modules/auth";
import { DirectorPage, ReviewPage, ShootPage } from "@/modules/director";
import { ProfileSettingsPage, SecuritySettingsPage, SettingsLayout } from "@/modules/settings";
import { HomePage, SavedPage, ShortsPlayerPage } from "@/modules/shorts";
import { renderHtml } from "../../test/next-server";
import * as director from "./(app)/director/[videoId]/page";
import * as review from "./(app)/director/[videoId]/review/page";
import * as shoot from "./(app)/director/[videoId]/shoot/page";
import * as library from "./(app)/library/page";
import * as saved from "./(app)/saved/page";
import SettingsRouteLayout from "./(app)/settings/layout";
import * as profile from "./(app)/settings/page";
import * as security from "./(app)/settings/security/page";
import * as short from "./(app)/shorts/[videoId]/page";
import * as shorts from "./(app)/shorts/page";
import * as forgotPassword from "./(auth)/forgot-password/page";
import AuthLayout from "./(auth)/layout";
import * as resetPassword from "./(auth)/reset-password/page";
import * as signIn from "./(auth)/sign-in/page";
import * as signUp from "./(auth)/sign-up/page";
import * as twoFactor from "./(auth)/two-factor/page";
import * as verifyEmail from "./(auth)/verify-email/page";
import * as privacy from "./privacy/page";
import * as terms from "./terms/page";

interface Route {
  generateMetadata: () => Promise<{ title?: unknown }>;
  default: unknown;
}

const pages: [string, Route, string, unknown][] = [
  ["/library", library, en.common.library, HomePage],
  ["/saved", saved, en.shorts.savedTitle, SavedPage],
  ["/settings", profile, en.settings.profile.title, ProfileSettingsPage],
  ["/settings/security", security, en.settings.security.title, SecuritySettingsPage],
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

  it("plays the Shorts feed, from the short in the address when there is one", async () => {
    expect(await rendered(shorts.default)).toEqual(<ShortsPlayerPage />);
    expect(
      await rendered(short.default, { params: Promise.resolve({ videoId: "kJQP7kiw5Fk" }) }),
    ).toEqual(<ShortsPlayerPage videoId="kJQP7kiw5Fk" />);
    expect(await shorts.generateMetadata()).toEqual({ title: en.shorts.title });
    expect(await short.generateMetadata()).toEqual({ title: en.shorts.title });
  });

  it("serves Director's pages for a short, with the shot and audio from the query", async () => {
    const params = Promise.resolve({ videoId: "dQw4w9WgXcQ" });
    expect(await rendered(director.default, { params })).toEqual(
      <DirectorPage videoId="dQw4w9WgXcQ" />,
    );
    expect(
      await rendered(shoot.default, {
        params,
        searchParams: Promise.resolve({ shot: ["2", "5"], audio: "voice" }),
      }),
    ).toEqual(<ShootPage videoId="dQw4w9WgXcQ" shot="2" audio="voice" />);
    expect(await rendered(shoot.default, { params, searchParams: Promise.resolve({}) })).toEqual(
      <ShootPage videoId="dQw4w9WgXcQ" shot={undefined} audio={undefined} />,
    );
    expect(
      await rendered(review.default, {
        params,
        searchParams: Promise.resolve({ audio: ["original", "voice"] }),
      }),
    ).toEqual(<ReviewPage videoId="dQw4w9WgXcQ" audio="original" wrap={false} />);
    expect(
      await rendered(review.default, { params, searchParams: Promise.resolve({ audio: "voice" }) }),
    ).toEqual(<ReviewPage videoId="dQw4w9WgXcQ" audio="voice" wrap={false} />);
    // Arriving from the last shot: the wrap.
    expect(
      await rendered(review.default, {
        params,
        searchParams: Promise.resolve({ audio: "voice", wrap: "1" }),
      }),
    ).toEqual(<ReviewPage videoId="dQw4w9WgXcQ" audio="voice" wrap />);
    expect(await director.generateMetadata()).toEqual({ title: en.director.title });
    expect(await shoot.generateMetadata()).toEqual({ title: en.director.title });
    expect(await review.generateMetadata()).toEqual({ title: en.director.review.title });
  });

  it("renders the sign-in steps, which read the query string, inside a Suspense boundary", () => {
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
