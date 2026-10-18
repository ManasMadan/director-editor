/**
 * Auth limits and settings as plain values (no zod), so the auth client every page
 * loads doesn't pull in the schema library. The schemas built from them are in auth.ts,
 * which re-exports all of this.
 */
import { DAY_S, HOUR_S } from "./time";
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
 * `demo` marks Director's demo (apps/api/src/auth/demo.ts): the shared demo account and
 * every demo guest. Publishing and account changes are off for it, and
 * `session.user.demo` is how the server and the web app tell. `guestUntil` is set on a
 * demo guest only (apps/api/src/auth/guest.ts): when it's deleted, with everything it
 * made. Neither is input: better-auth refuses them in sign-up and profile bodies, so only
 * the demo command and the guest sign-in set them (the columns default to false and null).
 */
export const userAdditionalFields = {
  locale: { type: "string", required: false, input: true },
  timezone: { type: "string", required: false, input: true },
  demo: { type: "boolean", required: false, input: false },
  guestUntil: { type: "date", required: false, input: false },
} as const;

/**
 * How long a demo guest lasts: its session ends, and the worker deletes it with its
 * workspace, its takes and its videos, this long after it was made.
 */
export const DEMO_GUEST_LIFETIME_S = DAY_S;

/**
 * Where apps/api's better-auth keeps sessions in Valkey (its secondary storage), which it
 * reads before Postgres: whatever deletes a user's sessions outside better-auth (the
 * worker's demo guest purge) deletes these keys too, or the sessions live on there.
 */
export const AUTH_STORAGE_PREFIX = "auth:";

/** A user's session keys in Valkey: each session by its token, and better-auth's list of them. */
export const authSessionKeys = (userId: string, tokens: readonly string[]) => [
  ...tokens.map((token) => `${AUTH_STORAGE_PREFIX}${token}`),
  `${AUTH_STORAGE_PREFIX}active-sessions-${userId}`,
];
