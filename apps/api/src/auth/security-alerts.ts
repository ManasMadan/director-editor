/**
 * Which account changes email the owner a security alert. Kept apart from the auth config
 * so the rules are unit-testable; auth-hooks.ts calls this from an after-hook on every request.
 */

import { hasKey } from "@repo/contracts/objects";
import type { SecurityEvent } from "@repo/jobs";

interface AfterHookContext {
  path?: string | undefined;
  body?: unknown;
  context: { session?: { user: { email: string; twoFactorEnabled?: boolean | null } } | null };
}

/** What changed; an approved app (MCP client) also names the client. */
export type SecurityChange =
  | { event: Exclude<SecurityEvent, "app-connected">; newEmail?: string }
  | { event: "app-connected"; clientId: string };

/** A change and the address its alert goes to. */
export type SecurityAlert = SecurityChange & { email: string };

type User = NonNullable<AfterHookContext["context"]["session"]>["user"];
type Body = { email?: unknown; newEmail?: unknown; accept?: unknown; oauth_query?: unknown };

/** Per auth path: the alert its success sends, if any. */
const ALERTS: Record<string, (user: User | undefined, body: Body) => SecurityAlert | undefined> = {
  "/change-password": (user) => user && { event: "password-changed", email: user.email },
  "/email-otp/reset-password": (_, body) =>
    typeof body.email === "string"
      ? { event: "password-reset", email: body.email.toLowerCase() }
      : undefined,
  // To the old address: the session still holds the pre-change user.
  "/email-otp/change-email": (user, body) =>
    user && typeof body.newEmail === "string"
      ? { event: "email-changed", email: user.email, newEmail: body.newEmail.toLowerCase() }
      : undefined,
  // With a session this confirms setup; during sign-in there is no session yet.
  "/two-factor/verify-totp": (user) =>
    user && !user.twoFactorEnabled ? { event: "two-factor-enabled", email: user.email } : undefined,
  "/two-factor/disable": (user) => user && { event: "two-factor-disabled", email: user.email },
  "/passkey/verify-registration": (user) => user && { event: "passkey-added", email: user.email },
  // An app (an MCP client) was approved; the signed request names it.
  "/oauth2/consent": (user, body) => {
    const clientId =
      typeof body.oauth_query === "string"
        ? new URLSearchParams(body.oauth_query).get("client_id")
        : null;
    return user && body.accept === true && clientId
      ? { event: "app-connected", email: user.email, clientId }
      : undefined;
  },
};

/** Which security alert (if any) a successful auth request should send, and to whom. */
export function securityAlertFor(ctx: AfterHookContext): SecurityAlert | undefined {
  const path = ctx.path ?? "";
  const alert = hasKey(ALERTS, path) ? ALERTS[path] : undefined;
  return alert?.(ctx.context.session?.user, (ctx.body ?? {}) as Body);
}
