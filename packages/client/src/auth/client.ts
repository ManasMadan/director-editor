/**
 * The browser/mobile side of better-auth (server: apps/api/src/auth/auth.ts). Client
 * plugins mirror the server's plugins so their methods exist and are typed:
 * `authClient.emailOtp.*`, `authClient.twoFactor.*`, `authClient.passkey.*`,
 * `authClient.organization.*`, `authClient.admin.*`.
 *
 * Web uses `createAppAuthClient()`. Mobile builds its client from `authClientPlugins`
 * plus the Expo plugin (secure session storage), so both expose the same methods.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { userAdditionalFields } from "@repo/contracts/auth-settings";
import type { Session } from "better-auth";
import {
  adminClient,
  emailOTPClient,
  inferAdditionalFields,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClientPlugins = (options: { onTwoFactorRequired?: () => void } = {}) => [
  emailOTPClient(),
  twoFactorClient({
    ...(options.onTwoFactorRequired && { onTwoFactorRedirect: options.onTwoFactorRequired }),
  }),
  passkeyClient(),
  organizationClient(),
  adminClient(),
  inferAdditionalFields({ user: userAdditionalFields }),
];

export interface AuthClientOptions {
  /** Origin serving /api/auth; omit for same origin (web). */
  baseUrl?: string;
  /** Called when a sign-in needs a second factor (TOTP or backup code). */
  onTwoFactorRequired?: () => void;
}

export function createAppAuthClient({ baseUrl, onTwoFactorRequired }: AuthClientOptions = {}) {
  return createAuthClient({
    ...(baseUrl !== undefined && { baseURL: baseUrl }),
    plugins: authClientPlugins({ ...(onTwoFactorRequired && { onTwoFactorRequired }) }),
  });
}

type AuthClient = ReturnType<typeof createAppAuthClient>;

/**
 * What the auth hooks (`src/auth/*`) call. The app passes its own client:
 * `useSessionsQuery(authClient)`.
 */
export type AuthQueryClient = Pick<AuthClient, "useSession" | "listSessions" | "passkey">;

// better-auth's client types the plugins' answers as any (sessions, passkeys). These are
// the server's own model types for them: give a query its result type with them, so what
// the page reads from it is checked.
export type SignedInSession = Session;
export type { Passkey as UserPasskey } from "@better-auth/passkey";
