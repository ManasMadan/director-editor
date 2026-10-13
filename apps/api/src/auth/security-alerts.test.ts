import { describe, expect, it } from "vitest";
import { securityAlertFor } from "./security-alerts";

const session = (twoFactorEnabled = false) => ({
  user: { email: "owner@example.com", twoFactorEnabled },
});

describe("securityAlertFor", () => {
  it.each([
    ["/change-password", "password-changed"],
    ["/two-factor/disable", "two-factor-disabled"],
    ["/passkey/verify-registration", "passkey-added"],
  ] as const)("%s alerts the signed-in user", (path, event) => {
    expect(securityAlertFor({ path, context: { session: session() } })).toEqual({
      event,
      email: "owner@example.com",
    });
  });

  it("sends an email change to the old address, naming the new one", () => {
    expect(
      securityAlertFor({
        path: "/email-otp/change-email",
        body: { newEmail: "New@Example.com" },
        context: { session: session() },
      }),
    ).toEqual({ event: "email-changed", email: "owner@example.com", newEmail: "new@example.com" });
  });

  it("alerts a password reset by the address in the request (no session)", () => {
    expect(
      securityAlertFor({
        path: "/email-otp/reset-password",
        body: { email: "Owner@Example.com" },
        context: {},
      }),
    ).toEqual({
      event: "password-reset",
      email: "owner@example.com",
    });
  });

  it("treats a TOTP check as setup only when signed in and not yet enabled", () => {
    expect(
      securityAlertFor({ path: "/two-factor/verify-totp", context: { session: session(false) } })
        ?.event,
    ).toBe("two-factor-enabled");
    // Signing in with a code: already enabled, or no session yet.
    expect(
      securityAlertFor({ path: "/two-factor/verify-totp", context: { session: session(true) } }),
    ).toBeUndefined();
    expect(securityAlertFor({ path: "/two-factor/verify-totp", context: {} })).toBeUndefined();
  });

  it("needs the address a password was reset for, and the new address of an email change", () => {
    expect(
      securityAlertFor({ path: "/email-otp/reset-password", body: {}, context: {} }),
    ).toBeUndefined();
    expect(
      securityAlertFor({ path: "/email-otp/change-email", context: { session: session() } }),
    ).toBeUndefined();
  });

  it("names the app a consent approved, only when it was approved", () => {
    const consent = (body: unknown) =>
      securityAlertFor({ path: "/oauth2/consent", body, context: { session: session() } });
    expect(consent({ accept: true, oauth_query: "client_id=app-1&scope=openid" })).toEqual({
      event: "app-connected",
      email: "owner@example.com",
      clientId: "app-1",
    });
    expect(consent({ accept: false, oauth_query: "client_id=app-1" })).toBeUndefined();
    expect(consent({ accept: true })).toBeUndefined();
  });

  it("ignores everything else", () => {
    expect(
      securityAlertFor({ path: "/sign-in/email", context: { session: session() } }),
    ).toBeUndefined();
    expect(securityAlertFor({ path: "/change-password", context: {} })).toBeUndefined();
    // A request without a path, and one that names an object's own property.
    expect(securityAlertFor({ context: { session: session() } })).toBeUndefined();
    expect(securityAlertFor({ path: "toString", context: { session: session() } })).toBeUndefined();
  });
});
