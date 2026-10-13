/**
 * The API client for the app (packages/client), with what's specific to a device: the
 * absolute API URL, and the session cookie from secure storage on every request.
 */
import { ApiProvider as SharedApiProvider } from "@repo/client";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { authClient } from "./auth-client";
import { apiUrl, appVersion } from "./config";

let switchingWorkspace = false;

export function ApiProvider({ locale, children }: { locale: string; children: ReactNode }) {
  return (
    <SharedApiProvider
      options={{
        ...(Platform.OS !== "web" && { baseUrl: apiUrl }),
        appVersion,
        getLocale: () => locale,
        getHeaders: async (): Promise<Record<string, string>> => {
          if (Platform.OS === "web") {
            return {};
          }
          const cookie = await authClient.getCookie();
          return cookie ? { cookie } : {};
        },
      }}
      // The session ended (signed out elsewhere, expired, revoked).
      onUnauthenticated={async () => {
        await authClient.signOut();
        router.replace("/sign-in");
      }}
      onOutdated={() => router.replace("/update-required")}
      // Removed from the active workspace (or it was deleted): move to another one.
      onNoOrganization={async () => {
        if (switchingWorkspace) {
          return;
        }
        switchingWorkspace = true;
        try {
          const { data } = await authClient.organization.list();
          const next = data?.[0];
          if (next) {
            await authClient.organization.setActive({ organizationId: next.id });
          }
        } finally {
          switchingWorkspace = false;
        }
      }}
    >
      {children}
    </SharedApiProvider>
  );
}
