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
import { DirectorPage, EditPage, LibraryPage, MediaPage, ShootPage } from "@/modules/director";
import { LegalPage } from "@/modules/marketing";
import { ProfileSettingsPage, SecuritySettingsPage, SettingsLayout } from "@/modules/settings";
import * as edit from "./(app)/director/[videoId]/edit/page";
import * as director from "./(app)/director/[videoId]/page";
import * as shoot from "./(app)/director/[videoId]/shoot/page";
import * as library from "./(app)/library/page";
import * as media from "./(app)/media/page";
import SettingsRouteLayout from "./(app)/settings/layout";
import * as profile from "./(app)/settings/page";
import * as security from "./(app)/settings/security/page";
import * as short from "./(app)/shorts/[videoId]/page";
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
  ["/library", library, en.common.library, LibraryPage],
  ["/media", media, en.director.media.title, MediaPage],
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

  it("sends an old link to a short on to its page in Director, for good", async () => {
    await expect(
      short.default({
        params: Promise.resolve({ videoId: "kJQP7kiw5Fk" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/director/kJQP7kiw5Fk;308;" });
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
    ).toEqual(<ShootPage videoId="dQw4w9WgXcQ" shot="2" audio="voice" back={undefined} />);
    // A retake from the editor goes back there once it's kept.
    expect(
      await rendered(shoot.default, {
        params,
        searchParams: Promise.resolve({ shot: "1", audio: "voice", back: "edit" }),
      }),
    ).toEqual(<ShootPage videoId="dQw4w9WgXcQ" shot="1" audio="voice" back="edit" />);
    expect(await rendered(shoot.default, { params, searchParams: Promise.resolve({}) })).toEqual(
      <ShootPage videoId="dQw4w9WgXcQ" shot={undefined} audio={undefined} back={undefined} />,
    );
    expect(
      await rendered(edit.default, {
        params,
        searchParams: Promise.resolve({ audio: ["original", "voice"] }),
      }),
    ).toEqual(<EditPage videoId="dQw4w9WgXcQ" audio="original" wrap={false} />);
    expect(
      await rendered(edit.default, { params, searchParams: Promise.resolve({ audio: "voice" }) }),
    ).toEqual(<EditPage videoId="dQw4w9WgXcQ" audio="voice" wrap={false} />);
    // Arriving from the last shot: the wrap.
    expect(
      await rendered(edit.default, {
        params,
        searchParams: Promise.resolve({ audio: "voice", wrap: "1" }),
      }),
    ).toEqual(<EditPage videoId="dQw4w9WgXcQ" audio="voice" wrap />);
    expect(await director.generateMetadata()).toEqual({ title: en.director.title });
    expect(await shoot.generateMetadata()).toEqual({ title: en.director.title });
    expect(await edit.generateMetadata()).toEqual({ title: en.director.editor.title });
  });

  it("renders the sign-in steps, which read the query string, inside a Suspense boundary", () => {
    const children = <p>step</p>;
    expect(AuthLayout({ children })).toEqual(<Suspense>{children}</Suspense>);
  });

  it("frames the settings pages", () => {
    const children = <p>tab</p>;
    expect(SettingsRouteLayout({ children })).toEqual(<SettingsLayout>{children}</SettingsLayout>);
  });

  it("serves the legal pages, titled", async () => {
    expect(await rendered(terms.default)).toEqual(<LegalPage document="terms" />);
    expect(await terms.generateMetadata()).toEqual({ title: en.legal.terms });
    expect(await rendered(privacy.default)).toEqual(<LegalPage document="privacy" />);
    expect(await privacy.generateMetadata()).toEqual({ title: en.legal.privacy });
  });
});
