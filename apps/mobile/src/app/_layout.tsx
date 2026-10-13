/**
 * The root of the app: translations (the user's language once signed in), the API
 * client, and the navigation stack. Screens in (auth) are for signed-out users and (app)
 * for signed-in ones: protected routes switch between them as the session changes (sign
 * in, sign out, a revoked session) without remounting the navigator, so a screen pushed
 * during sign-up (the email code) stays put while the session is refetched.
 */
import "../../global.css";
import { isLocale } from "@repo/i18n/locales";
import { PortalHost } from "@rn-primitives/portal";
import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { Suspense, useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ApiProvider } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { deviceLocale, I18nProvider } from "@/lib/i18n";
import { presentForegroundNotifications } from "@/lib/push";

presentForegroundNotifications();
// On the web build the captcha check runs in a popup, which comes back to this app: hand
// its URL to the window waiting for it (lib/captcha.ts). Does nothing anywhere else.
WebBrowser.maybeCompleteAuthSession();
// Until the stored session is known, so the first screen is the right one.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { data: session, isPending } = authClient.useSession();
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!isPending && !started) {
      setStarted(true);
      SplashScreen.hide();
    }
  }, [isPending, started]);
  if (!started) {
    return null;
  }

  const saved = session?.user.locale;
  const locale = isLocale(saved) ? saved : deviceLocale();
  const signedIn = Boolean(session);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Suspense fallback={null}>
        <I18nProvider locale={locale}>
          <ApiProvider locale={locale}>
            <StatusBar style="auto" />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Protected guard={signedIn}>
                <Stack.Screen name="(app)" />
                <Stack.Screen name="invitations/[id]" />
              </Stack.Protected>
              <Stack.Protected guard={!signedIn}>
                <Stack.Screen name="(auth)" />
              </Stack.Protected>
              <Stack.Screen name="update-required" />
            </Stack>
            <PortalHost />
          </ApiProvider>
        </I18nProvider>
      </Suspense>
    </GestureHandlerRootView>
  );
}
