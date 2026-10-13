/**
 * Which audit events better-auth activity produces. The auth config records them from
 * its hooks; the mapping lives here so it's readable and unit-tested on its own.
 *
 * better-auth commits its own writes, so these events are recorded right after the fact
 * in a separate transaction (product events, by contrast, share the change's
 * transaction). A crash in between loses the audit entry, never the change.
 */
import type { EventPayload } from "@repo/contracts/events";
import type { UserId } from "@repo/contracts/ids";
import type { AnyEvent } from "../outbox";
import type { SecurityChange } from "./security-alerts";

type SessionMethod = EventPayload<"auth.session_started.v1">["method"];
type SessionEndReason = EventPayload<"auth.session_ended.v1">["reason"];

/** How a new session was obtained, from the endpoint that created it. */
export function sessionMethod(path: string | undefined): SessionMethod {
  if (!path) {
    return "other";
  }
  if (path === "/sign-in/email" || path === "/sign-up/email") {
    return "password";
  }
  if (path.startsWith("/passkey/")) {
    return "passkey";
  }
  if (path.startsWith("/callback/") || path.startsWith("/sign-in/social")) {
    return "social";
  }
  if (path.startsWith("/two-factor/")) {
    return "two-factor";
  }
  if (path.startsWith("/email-otp/")) {
    return "email-code";
  }
  if (path.startsWith("/admin/impersonate")) {
    return "impersonation";
  }
  return "other";
}

/** Why a session ended, from the endpoint that ended it. */
export function sessionEndReason(path: string | undefined): SessionEndReason {
  switch (path) {
    case "/sign-out":
    case "/admin/stop-impersonating":
      return "sign-out";
    case "/revoke-session":
    case "/revoke-sessions":
    case "/revoke-other-sessions":
    case "/admin/revoke-user-session":
    case "/admin/revoke-user-sessions":
      return "revoked";
    case "/change-password":
      return "password-change";
    case "/email-otp/reset-password":
    case "/reset-password":
      return "password-reset";
    case "/delete-user":
    case "/admin/remove-user":
      return "account-deleted";
    default:
      return "other";
  }
}

/** The audit event for a security alert (both describe the same account change). */
export function auditEventForAlert(change: SecurityChange, userId: UserId): AnyEvent {
  switch (change.event) {
    case "password-changed":
      return { name: "auth.password_changed.v1", payload: { userId } };
    case "password-reset":
      return { name: "auth.password_reset.v1", payload: { userId } };
    case "email-changed":
      return { name: "auth.email_changed.v1", payload: { userId } };
    case "two-factor-enabled":
      return { name: "auth.two_factor_changed.v1", payload: { userId, enabled: true } };
    case "two-factor-disabled":
      return { name: "auth.two_factor_changed.v1", payload: { userId, enabled: false } };
    case "passkey-added":
      return { name: "auth.passkey_added.v1", payload: { userId } };
    case "phone-added":
      return { name: "auth.phone_changed.v1", payload: { userId, change: "added" } };
    case "phone-removed":
      return { name: "auth.phone_changed.v1", payload: { userId, change: "removed" } };
    case "app-connected":
      return { name: "auth.app_connected.v1", payload: { userId, clientId: change.clientId } };
  }
}
