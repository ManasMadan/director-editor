/**
 * Accounts for browser tests, made through the API's own auth endpoints from the test
 * page, so the session cookie lands in the browser like after a real sign-up.
 */
import { createApiClient } from "@repo/client";
import { commands } from "vitest/browser";
import { authClient } from "@/lib/auth-client";

/** The typed API client, as the page's signed-in user (for setup the UI doesn't offer). */
export const api = createApiClient().client;

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
}

const id = () => crypto.randomUUID();

export const newUser = () => ({
  name: `Web ${id().slice(0, 8)}`,
  email: `web-${id()}@example.com`,
  // Random, so the breached-password check never rejects it.
  password: `pw-${id()}`,
});

/**
 * Calls a better-auth endpoint as the page. The captcha token is Cloudflare's test
 * token, which the API with captcha on accepts with its test secret (and the other
 * API ignores).
 */
export async function auth<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${text}`);
  }
  // The page's auth client learns of it, as after its own calls (useSession refetches).
  authClient.$store.notify("$sessionSignal");
  return (text ? JSON.parse(text) : null) as T;
}

/** The one-time code the API queued for an email address. */
export async function takeOtp(email: string) {
  const { otp } = await commands.takeNotification<{ otp: string }>("auth.otp", email);
  return otp;
}

/** A new, verified user, signed in on this page. */
export async function signUp(details: Partial<ReturnType<typeof newUser>> = {}): Promise<User> {
  const user = { ...newUser(), ...details };
  // On the API with captcha on, sign-up checks the token with Cloudflare over the
  // internet and answers 500 when that call fails. Only that is retried.
  for (let attempt = 1; ; attempt++) {
    const failed = await auth("/sign-up/email", user).then(
      () => undefined,
      (error: Error) => error,
    );
    if (!failed) {
      break;
    }
    if (attempt === 3 || !failed.message.includes("answered 500")) {
      throw failed;
    }
  }
  await auth("/email-otp/verify-email", { email: user.email, otp: await takeOtp(user.email) });
  const session = await currentSession();
  return { ...user, id: session.user.id };
}

export const signOut = () => auth("/sign-out");

/** The signed-in session, as better-auth's get-session answers it. */
export const currentSession = () =>
  fetch("/api/auth/get-session").then(
    (response) =>
      response.json() as Promise<{
        session: { activeOrganizationId: string | null };
        user: { id: string; name: string; email: string } & Record<string, unknown>;
      }>,
  );

/** Signs `user` in on the page (replacing whoever was). */
export const signIn = (user: Pick<User, "email" | "password">) =>
  auth("/sign-in/email", { email: user.email, password: user.password });

/** Turns on two-step verification for the signed-in user; returns its secret and backup codes. */
export async function enableTwoFactor(user: User) {
  const { totpURI, backupCodes } = await auth<{ totpURI: string; backupCodes: string[] }>(
    "/two-factor/enable",
    { password: user.password },
  );
  const secret = new URL(totpURI).searchParams.get("secret") as string;
  await auth("/two-factor/verify-totp", { code: await commands.totp(secret) });
  return { secret, backupCodes };
}

/** Calls an auth endpoint until the API refuses it as too many attempts (per IP or address). */
export async function rateLimit(path: string, body: unknown) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX",
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      return;
    }
  }
  throw new Error(`${path} was never rate limited`);
}

/**
 * A shared workspace owned by `owner` (signed in on the page), with `member` invited to
 * it as `role` and joined. Leaves `member` signed in with the workspace active.
 */
export async function sharedWorkspace(
  owner: User,
  member: User,
  role: "member" | "admin" = "member",
) {
  await auth("/sign-in/email", { email: owner.email, password: owner.password });
  const workspace = await auth<{ id: string; name: string }>("/organization/create", {
    name: `Team ${crypto.randomUUID().slice(0, 6)}`,
    slug: `team-${crypto.randomUUID().slice(0, 8)}`,
  });
  await auth("/organization/set-active", { organizationId: workspace.id });
  await auth("/organization/invite-member", {
    email: member.email,
    role,
    organizationId: workspace.id,
  });
  const { acceptUrl } = await commands.takeNotification<{ acceptUrl: string }>(
    "org.invitation",
    member.email,
  );
  await signOut();
  await auth("/sign-in/email", { email: member.email, password: member.password });
  await auth("/organization/accept-invitation", {
    invitationId: acceptUrl.split("/").at(-1),
  });
  await auth("/organization/set-active", { organizationId: workspace.id });
  return workspace;
}
