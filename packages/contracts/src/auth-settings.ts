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
 * (better-auth's freshAge); after it, sign in again.
 */
export const FRESH_SESSION_AGE = 2 * HOUR_S;

/** Workspaces one account may belong to, including those it created. */
export const ORGANIZATION_LIMIT = 20;

/**
 * People one workspace may have. Director gives each person one personal workspace of
 * their own, never shared, so it is one: its owner, and nobody can be invited.
 */
export const WORKSPACE_MEMBER_LIMIT = 1;

/**
 * Extra columns on the auth user, in better-auth's field format. The server registers
 * them (`user.additionalFields`) and clients infer them (`inferAdditionalFields`), so
 * `authClient.updateUser({ locale })` and `session.user.timezone` are typed on both
 * sides. No defaultValue: see the sign-up hook in apps/api/src/auth/auth.ts.
 *
 * `demo` marks Director's shared demo account (apps/api/src/auth/demo.ts):
 * publishing and account changes are off for it, and `session.user.demo` is how the
 * server and the web app tell. Never input: better-auth refuses it in sign-up and profile
 * bodies, so only the demo command sets it (the column defaults to false).
 */
export const userAdditionalFields = {
  locale: { type: "string", required: false, input: true },
  timezone: { type: "string", required: false, input: true },
  demo: { type: "boolean", required: false, input: false },
} as const;
