/**
 * Auth limits and settings as plain values (no zod), so the auth client every page
 * loads doesn't pull in the schema library. The schemas built from them are in auth.ts,
 * which re-exports all of this.
 */
import { HOUR_S } from "./time";
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;
export const OTP_LENGTH = 6;
/** Seconds an emailed code stays valid. */
export const OTP_EXPIRES_IN = 5 * 60;

/**
 * "Sudo mode": sensitive changes need a session signed in within this many seconds
 * (better-auth's freshAge, and the API's `fresh` procedures); after it, sign in again.
 */
export const FRESH_SESSION_AGE = 2 * HOUR_S;

/**
 * Workspaces one account may belong to (including those it created), and invitations
 * one workspace may have waiting: each invitation is an email from our domain with a
 * name someone else chose, so neither can be unbounded.
 */
export const ORGANIZATION_LIMIT = 20;
export const PENDING_INVITATION_LIMIT = 20;

/** Digits a texted code has, and how long (seconds) it stays valid. */
export const PHONE_CODE_LENGTH = 6;
export const PHONE_CODE_EXPIRES_IN = 10 * 60;

/**
 * Extra columns on the auth user, in better-auth's field format. The server registers
 * them (`user.additionalFields`) and clients infer them (`inferAdditionalFields`), so
 * `authClient.updateUser({ locale })` and `session.user.timezone` are typed on both
 * sides. No defaultValue: see the sign-up hook in apps/api/src/auth/auth.ts.
 */
export const userAdditionalFields = {
  locale: { type: "string", required: false, input: true },
  timezone: { type: "string", required: false, input: true },
} as const;
