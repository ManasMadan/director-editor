/**
 * Which translated sentence (`authErrors.*` in packages/i18n) an auth failure shows, on
 * every app. Kept apart from the form schemas so a component that only reports errors
 * (a menu, a dialog trigger) doesn't load them.
 */
import { AUTH_ERROR_ALIASES, type AuthErrorCode, isAuthErrorCode } from "@repo/contracts/errors";

/**
 * The `authErrors.*` key for a better-auth failure (INVALID_EMAIL_OR_PASSWORD,
 * INVALID_OTP, ...; see AUTH_ERROR_CODES), or undefined for "show the generic sentence".
 * Accepts anything thrown or returned: only `code`, `error` (OAuth endpoints) and
 * `status` are read. The server's English message is never shown.
 */
export function authErrorKey(error: unknown): AuthErrorCode | undefined {
  const {
    code,
    error: oauthError,
    status,
  } = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    error?: unknown;
    status?: unknown;
  };
  // The rate limiter answers 429 without a code.
  const raw =
    status === 429 ? "RATE_LIMITED" : [code, oauthError].find((value) => typeof value === "string");
  const key =
    raw !== undefined && Object.hasOwn(AUTH_ERROR_ALIASES, raw) ? AUTH_ERROR_ALIASES[raw] : raw;
  return isAuthErrorCode(key) ? key : undefined;
}
