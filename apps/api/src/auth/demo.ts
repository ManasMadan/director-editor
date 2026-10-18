/**
 * Director's shared demo account: one account anyone may sign in to from the sign-in page
 * (its email and DEMO_PASSWORD come from `system.info`), so a judge tries Director in one
 * click. `bun run --filter @repo/api director:demo-account` makes it (demo-account.ts).
 *
 * It's an ordinary verified account with `demo` set on its user row, which better-auth
 * hands back on every session (`session.user.demo`; userAdditionalFields in
 * @repo/contracts/auth-settings). Everyone shares it, so:
 * - it can't publish: whatever publishes refuses a session whose user has `demo` set,
 *   with DEMO_ACCOUNT_LOCKED;
 * - it can't change or lock the account itself (DEMO_LOCKED_PATHS, refused by the auth
 *   hooks): one judge changing the password, turning on two-step verification or
 *   signing everyone else out would lock the next judge out;
 * - its sign-in has no per-account attempt limit (account-limits.ts): the password is
 *   public, so there's nothing to guess, and the limit would let anyone lock it.
 * It indexes a Short of its own like anyone (the usual one), and its library starts with
 * the seeded templates.
 */
import { fieldOf } from "@repo/contracts/objects";
import { APIError } from "better-auth/api";

/** The demo account's address: on Director's own domain, so nobody else can own it. */
export const DEMO_EMAIL = "demo@director.mmadan.in";

/**
 * The auth endpoints the demo account may not use: changing its password, deleting it,
 * turning on two-step verification, linking someone's Google account to it, and ending
 * other people's sessions on it. (Its email can't change and its password can't be
 * reset: both need a code sent to its address, which nobody trying it reads.)
 */
export const DEMO_LOCKED_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/delete-user",
  "/two-factor/enable",
  "/link-social",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

/**
 * Refuses one of DEMO_LOCKED_PATHS when the session's user is the demo account. The user
 * as a hook gets it, whose extra fields better-auth leaves untyped.
 */
export function refuseForDemo(user: unknown) {
  if (fieldOf(user, "demo") === true) {
    throw new APIError("FORBIDDEN", {
      code: "DEMO_ACCOUNT_LOCKED",
      message: "The shared demo account can't change itself.",
    });
  }
}
