/**
 * Where the app finds the API, and which version it is (sent as x-app-version, so the API
 * can require an update of builds too old to work: CLIENT_OUTDATED).
 *
 * On a device the API is at EXPO_PUBLIC_API_URL (inlined at build time; see
 * app.config.ts). On the web the app is served with the API on its own origin, like
 * apps/web, so cookies stay first-party.
 */
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";
import * as z from "zod";

function nativeApiUrl() {
  const parsed = z.url().safeParse(process.env.EXPO_PUBLIC_API_URL);
  if (!parsed.success) {
    throw new Error(
      "EXPO_PUBLIC_API_URL must be the site's URL (e.g. http://192.168.1.10:3000 in development).",
    );
  }
  return parsed.data.replace(/\/+$/, "");
}

export const apiUrl = Platform.OS === "web" ? window.location.origin : nativeApiUrl();

export const appVersion =
  Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0.0.0";
