/**
 * Director's shared demo account: one account anyone may sign in to from the sign-in page
 * (its email and DEMO_PASSWORD come from `system.info`), so a judge tries Director in one
 * click. `bun run --filter @repo/api director:demo-account` makes it (demo-account.ts).
 *
 * It's an ordinary verified account with `demo` set on its user row, which better-auth
 * hands back on every session (`session.user.demo`; userAdditionalFields in
 * @repo/contracts/auth-settings). Everyone shares it, so nobody signed in to it may
 * change it for the next person, or see who else uses it:
 * - it can't publish: whatever publishes refuses a session whose user has `demo` set,
 *   with PUBLISH_DEMO_DISABLED (modules/publish), and its profile picture with
 *   DEMO_ACCOUNT_LOCKED (modules/user);
 * - it can't change, lock or empty the account or its workspace (DEMO_LOCKED_PATHS, and
 *   its name only through the command: refuseDemoProfileChange), all refused by the auth
 *   hooks: one judge changing the password, signing everyone out or deleting the
 *   workspace with everyone's takes would break it for the next;
 * - its device list shows only the device asking (ownSessionOnly), never the addresses
 *   and browsers of everyone else signed in to it;
 * - while DEMO_PASSWORD is set, its sign-in has no per-account attempt limit
 *   (account-limits.ts): the password is public, so there's nothing to guess, and the
 *   limit would let anyone lock it.
 * It indexes a Short of its own like anyone (the usual one), and its library starts with
 * the seeded templates.
 *
 * With demo guests on (guest.ts), each browser gets a private guest instead, flagged
 * `demo` too, so every restriction here holds for guests as well: a guest can't publish
 * (it has no Google account to post with), and nothing it could change about its account
 * (a password, a passkey, a linked Google account) would outlive its day. The shared
 * account then stays as the fallback for when a guest can't be made.
 */
import { fieldOf } from "@repo/contracts/objects";
import { APIError } from "better-auth/api";

/** The demo account's address: on Director's own domain, so nobody else can own it. */
export const DEMO_EMAIL = "demo@director.mmadan.in";

/**
 * The auth endpoints the demo account may not use: changing its password, deleting it,
 * turning on two-step verification, linking someone's Google account or passkey to it
 * (either would outlive the demo password being changed or withdrawn), ending other
 * people's sessions on it, and making, renaming, leaving or deleting a workspace. (Its
 * email can't change and its password can't be reset: both need a code sent to its
 * address, which nobody trying it reads.) hook-paths.test.ts checks each is an endpoint.
 */
export const DEMO_LOCKED_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/delete-user",
  "/two-factor/enable",
  "/link-social",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/organization/create",
  "/organization/update",
  "/organization/leave",
  "/organization/delete",
]);

const isDemo = (user: unknown) => fieldOf(user, "demo") === true;

/**
 * Refuses one of DEMO_LOCKED_PATHS when the session's user is the demo account or a demo
 * guest. The user as a hook gets it, whose extra fields better-auth leaves untyped.
 */
export function refuseForDemo(user: unknown) {
  if (isDemo(user)) {
    throw new APIError("FORBIDDEN", {
      code: "DEMO_ACCOUNT_LOCKED",
      message: "The demo can't change its account.",
    });
  }
}

/**
 * What the demo account may change about itself: the language and time zone its own
 * browser reports (the web app sends them on its own), and the timestamp better-auth adds.
 */
const DEMO_PROFILE_FIELDS: ReadonlySet<string> = new Set(["locale", "timezone", "updatedAt"]);

/**
 * Refuses a profile edit by the demo account that changes more than DEMO_PROFILE_FIELDS. A
 * field sent with the value it already has isn't a change: the settings form sends the name
 * along with a new language or time zone.
 */
export function refuseDemoProfileChange(change: Record<string, unknown>, user: unknown) {
  const changes = Object.entries(change).filter(
    ([field, value]) => value !== undefined && value !== fieldOf(user, field),
  );
  if (changes.some(([field]) => !DEMO_PROFILE_FIELDS.has(field))) {
    refuseForDemo(user);
  }
}

/**
 * The device list as the demo account may see it: only the session asking, since every
 * other one is someone else trying Director. Anyone else's is untouched. Undefined when
 * there's nothing to change.
 */
export function ownSessionOnly(
  listed: unknown,
  session: { user: unknown; session: { id: string } } | null | undefined,
) {
  if (!session || !isDemo(session.user) || !Array.isArray(listed)) {
    return undefined;
  }
  return listed.filter((row: unknown) => fieldOf(row, "id") === session.session.id);
}
