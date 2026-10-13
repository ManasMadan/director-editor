/**
 * Passkeys: the same better-auth endpoints the web app's passkey client calls, with the
 * device's own prompt (react-native-passkeys: AuthenticationServices on iOS, Credential
 * Manager on Android, WebAuthn on the web build) in place of the browser's. A device
 * shows it only for the site the build is associated with (app.config.ts,
 * `webcredentials`), which is the relying party; the API accepts the Android app's own
 * origin too (apps/api/src/auth/auth.ts).
 *
 * A prompt that didn't finish (closed, timed out, no passkey on the device) is the error
 * AUTH_CANCELLED, as on the web.
 */
import * as Passkeys from "react-native-passkeys";
import { authClient } from "./auth-client";

type RequestOptions = Parameters<typeof Passkeys.get>[0];
type CreationOptions = Parameters<typeof Passkeys.create>[0];

const cancelled = { code: "AUTH_CANCELLED", status: 400 };

/** Whether this device can use passkeys at all (iOS 15, Android 9 and later; WebAuthn). */
export const passkeysSupported = () => Passkeys.isSupported();

/** Signs in with a passkey on this device; whether that made a session, and why not. */
export async function signInWithPasskey(): Promise<{ signedIn: boolean; error: unknown }> {
  const options = await authClient.$fetch<RequestOptions>(
    "/passkey/generate-authenticate-options",
    { method: "GET" },
  );
  if (!options.data) {
    return { signedIn: false, error: options.error };
  }
  const credential = await Passkeys.get(options.data).catch(() => null);
  if (!credential) {
    return { signedIn: false, error: cancelled };
  }
  const { error } = await authClient.$fetch("/passkey/verify-authentication", {
    method: "POST",
    body: { response: credential },
  });
  // The answer's cookie is the session. The Expo plugin keeps it on a device; reload the
  // session either way (the web build's browser keeps it without telling the client).
  authClient.$store.notify("$sessionSignal");
  return { signedIn: !error, error };
}

/** Adds a passkey on this device to the signed-in account. */
export async function addPasskey() {
  const options = await authClient.$fetch<CreationOptions>("/passkey/generate-register-options", {
    method: "GET",
  });
  if (!options.data) {
    return options;
  }
  const credential = await Passkeys.create(options.data).catch(() => null);
  if (!credential) {
    return { data: null, error: cancelled };
  }
  return authClient.$fetch("/passkey/verify-registration", {
    method: "POST",
    body: { response: credential },
  });
}
