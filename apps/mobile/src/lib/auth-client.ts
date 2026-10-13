/**
 * The app's better-auth client: the same plugins as the web app (packages/client), plus
 * Expo's, which keeps the session cookie in the device's secure storage (Keychain,
 * Keystore) and sends it with every auth request. The oRPC client reads it from here too
 * (lib/api.ts). On the web the browser keeps the cookie, as for apps/web.
 */
import { expoClient } from "@better-auth/expo/client";
import { authClientPlugins } from "@repo/client/auth";
import { createAuthClient } from "better-auth/react";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    expoClient({ scheme: "boilerplate", storagePrefix: "boilerplate", storage: SecureStore }),
    // A sign-in that needs a second factor continues on the two-step screen.
    ...authClientPlugins({ onTwoFactorRequired: () => router.push("/two-factor") }),
  ],
});

/**
 * Signs in with Google; whether that made a session, and why not if it failed (null when
 * the person closed the sign-in page).
 *
 * The link that brings the browser back to the app never carries the session: any app
 * can register our scheme on Android and catch it. The app asks the API for a hand-off
 * first, signs in with the hand-off's id in the callback, and trades the id and the secret
 * it kept for the session (apps/api/src/auth/mobile-sign-in.ts). The web build signs in
 * with the browser's own redirect, as the web app does.
 */
export async function signInWithGoogle(): Promise<{ signedIn: boolean; error: unknown }> {
  if (Platform.OS === "web") {
    const { error } = await authClient.signIn.social({ provider: "google", callbackURL: "/" });
    return { signedIn: false, error };
  }
  const handoff = await authClient.$fetch<{ id: string; secret: string }>("/mobile/sign-in/start", {
    method: "POST",
  });
  if (!handoff.data) {
    return { signedIn: false, error: handoff.error };
  }
  const callbackURL = `${Linking.createURL("/")}?handoff=${encodeURIComponent(handoff.data.id)}`;
  // The provider's page, opened here rather than by the Expo plugin, which would expect
  // the session in the link.
  const started = await authClient.signIn.social({
    provider: "google",
    callbackURL,
    disableRedirect: true,
  });
  const url = started.data && "url" in started.data ? started.data.url : undefined;
  if (!url) {
    return { signedIn: false, error: started.error };
  }
  const proxy = `${apiUrl}/api/auth/expo-authorization-proxy?${new URLSearchParams({ authorizationURL: url })}`;
  const result = await WebBrowser.openAuthSessionAsync(proxy, callbackURL);
  if (result.type !== "success") {
    return { signedIn: false, error: null };
  }
  // The answer's cookies are the session; the Expo plugin keeps them like any sign-in's.
  const finished = await authClient.$fetch("/mobile/sign-in/finish", {
    method: "POST",
    body: handoff.data,
  });
  return { signedIn: !finished.error, error: finished.error };
}
