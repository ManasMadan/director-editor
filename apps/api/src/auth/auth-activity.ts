/**
 * Account activity as activity lines (src/activity.ts): sign-ups, sign-ins and how,
 * sign-outs and revoked sessions, Google linked or allowed to upload, and the demo
 * account's refusals. What succeeded is written from better-auth's database hooks (they
 * know the user and the session); what failed, from the answer itself (auth.routes.ts),
 * since a refused sign-in writes nothing. Never the code, the password or a token: a
 * failed sign-in names only the address that was tried.
 */
import type { ActivityName } from "@repo/contracts/activity";
import { allowsUploads } from "@repo/contracts/api";
import type { Activity } from "@repo/nest-common";
import * as z from "zod";
import { sessionEndReason, sessionMethod } from "./auth-events";

type AuthActivity = Activity<ActivityName>;

/**
 * How someone signed in or up, from the endpoint: the demo account whatever the way in
 * (it signs in with its public password), Google for the social provider (the only one).
 */
export function signInMethod(path: string | undefined, demo: boolean): string {
  if (demo) {
    return "demo";
  }
  const method = sessionMethod(path);
  return method === "social" ? "google" : method;
}

/** A session that ended: signed out, or revoked (and why). */
export function sessionEnded(path: string | undefined, userId: string): AuthActivity {
  const reason = sessionEndReason(path);
  return reason === "sign-out"
    ? { activity: "auth.signed_out", target: { userId } }
    : { activity: "auth.session_revoked", target: { userId, reason } };
}

/** A Google account linked (at sign-up or later), and allowed to upload if it says so. */
export function googleLinked(account: { providerId: string; scope?: string | null }) {
  if (account.providerId !== "google") {
    return [];
  }
  const linked: AuthActivity = { activity: "auth.google_linked", target: { provider: "google" } };
  return allowsUploads(account.scope) ? [linked, youtubeGranted] : [linked];
}

export const youtubeGranted: AuthActivity = {
  activity: "auth.youtube_granted",
  target: { provider: "google" },
};

/** The endpoints a sign-in (or its second step) is attempted at, by email, code or passkey. */
const SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/sign-in/email-otp",
  "/email-otp/verify-email",
  "/passkey/verify-authentication",
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);
const SIGN_UP_PATH = "/sign-up/email";

/** Only the address of what was sent: the rest (a password, a code) is never read. */
const triedAddress = z.object({ email: z.string().max(320) });

function addressIn(body: unknown): string | undefined {
  if (!Buffer.isBuffer(body)) {
    return undefined;
  }
  try {
    return triedAddress.safeParse(JSON.parse(body.toString("utf8"))).data?.email;
  } catch {
    // Not JSON: there is no address to name.
    return undefined;
  }
}

/** What an auth endpoint answered, as auth.routes.ts sees it. */
export interface AuthAnswer {
  /** The endpoint, under /api/auth (`/sign-in/email`). */
  path: string;
  status: number;
  /** The error's code, when it answered one. */
  code: string | undefined;
  /** Where it redirected to (Google's callback). */
  location: string | null;
  /** The raw request body. */
  body: unknown;
}

/** Why a Google sign-in came back refused: the `error` its callback redirects with. */
function callbackError(location: string | null) {
  return location ? new URL(location, "http://localhost").searchParams.get("error") : null;
}

/**
 * The activity line for an auth answer that went wrong, or null: a sign-in or sign-up
 * refused (too many tries) or failed (a wrong password or code, an unverified address),
 * Google's sign-in coming back with an error, and anything the demo account was refused.
 */
export function failedAuthActivity(answer: AuthAnswer): AuthActivity | null {
  const { path, status, code } = answer;
  if (code === "DEMO_ACCOUNT_LOCKED") {
    return { activity: "auth.demo_refused", outcome: "refused", reason: code, target: { path } };
  }
  const googleError = path.startsWith("/callback/") ? callbackError(answer.location) : null;
  if (googleError) {
    return {
      activity: "auth.signed_in",
      outcome: "failed",
      reason: googleError,
      target: { method: "google" },
    };
  }
  if (status < 400 || !(SIGN_IN_PATHS.has(path) || path === SIGN_UP_PATH)) {
    return null;
  }
  const email = addressIn(answer.body);
  return {
    activity: path === SIGN_UP_PATH ? "auth.signed_up" : "auth.signed_in",
    outcome: status === 429 ? "refused" : "failed",
    reason: code ?? (status === 429 ? "RATE_LIMITED" : `HTTP_${status}`),
    ...(email && { actor: { email } }),
    target: { method: signInMethod(path, false) },
  };
}
