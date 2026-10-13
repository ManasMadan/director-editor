import { randomUUID } from "node:crypto";
import { userIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { auditEventForAlert, sessionEndReason, sessionMethod } from "./auth-events";

describe("auth audit events", () => {
  it.each([
    ["/sign-in/email", "password"],
    ["/passkey/verify-authentication", "passkey"],
    ["/callback/google", "social"],
    ["/two-factor/verify-totp", "two-factor"],
    ["/email-otp/verify-email", "email-code"],
    ["/admin/impersonate-user", "impersonation"],
    ["/magic-link/verify", "other"],
    [undefined, "other"],
  ] as const)("a session from %s was obtained by %s", (path, method) => {
    expect(sessionMethod(path)).toBe(method);
  });

  it.each([
    ["/sign-out", "sign-out"],
    ["/admin/stop-impersonating", "sign-out"],
    ["/revoke-session", "revoked"],
    ["/revoke-sessions", "revoked"],
    ["/revoke-other-sessions", "revoked"],
    ["/admin/revoke-user-session", "revoked"],
    ["/admin/revoke-user-sessions", "revoked"],
    ["/change-password", "password-change"],
    ["/email-otp/reset-password", "password-reset"],
    ["/reset-password", "password-reset"],
    ["/delete-user", "account-deleted"],
    ["/admin/remove-user", "account-deleted"],
    [undefined, "other"],
    ["/something-else", "other"],
  ] as const)("a session ended by %s ended because of %s", (path, reason) => {
    expect(sessionEndReason(path)).toBe(reason);
  });

  it.each([
    [{ event: "password-changed" }, "auth.password_changed.v1", {}],
    [{ event: "password-reset" }, "auth.password_reset.v1", {}],
    [{ event: "email-changed" }, "auth.email_changed.v1", {}],
    [{ event: "two-factor-enabled" }, "auth.two_factor_changed.v1", { enabled: true }],
    [{ event: "two-factor-disabled" }, "auth.two_factor_changed.v1", { enabled: false }],
    [{ event: "passkey-added" }, "auth.passkey_added.v1", {}],
    [{ event: "phone-added" }, "auth.phone_changed.v1", { change: "added" }],
    [{ event: "phone-removed" }, "auth.phone_changed.v1", { change: "removed" }],
    [{ event: "app-connected", clientId: "c1" }, "auth.app_connected.v1", { clientId: "c1" }],
  ] as const)("records the alert %o as %s", (change, name, payload) => {
    const userId = userIdSchema.parse(randomUUID());
    expect(auditEventForAlert(change, userId)).toEqual({
      name,
      payload: { userId, ...payload },
    });
  });
});
