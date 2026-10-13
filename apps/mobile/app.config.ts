/**
 * The app's configuration (Expo). Values that differ per environment come from the
 * environment at build time:
 *
 *   EXPO_PUBLIC_API_URL  the site's origin, where /rpc and /api/auth are served (the same
 *                        URL the web app is on; the gateway routes them to apps/api)
 *   APP_VARIANT          "development" | "preview" | "production": the app's name and
 *                        identifiers, so all three can be installed side by side
 *   EAS_PROJECT_ID       the project id `eas init` prints. With it, builds take
 *                        over-the-air updates from their channel (eas.json: development,
 *                        preview, production); without it there are no updates
 *   APPLE_TEAM_ID,       the same values the site has (apps/web/src/lib/app-links.ts):
 *   ANDROID_CERT_        with one set and an https site, the build claims that site's
 *   FINGERPRINTS         links and passkeys on iOS, or Android. Unset, it claims nothing,
 *                        since the site then serves no association file to check
 *
 * Native identifiers (bundle id, package) are set here once and never renamed after the
 * first store release.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

const variant = process.env.APP_VARIANT ?? "development";
const suffix = variant === "production" ? "" : `.${variant}`;
const name = variant === "production" ? "Boilerplate" : `Boilerplate (${variant})`;
const projectId = process.env.EAS_PROJECT_ID;

/**
 * The site's host, when it serves the association files a platform checks before it
 * trusts the app with the site's links (universal links, App Links) and passkeys: over
 * https only (a development build on a LAN address has none), and only once the site has
 * that platform's identifier (`identifier`, the same variable the site reads).
 */
function linkedHost(identifier: string | undefined) {
  const site = process.env.EXPO_PUBLIC_API_URL;
  return identifier && site?.startsWith("https://") ? new URL(site).hostname : undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosHost = linkedHost(process.env.APPLE_TEAM_ID);
  const androidHost = linkedHost(process.env.ANDROID_CERT_FINGERPRINTS);
  return {
    ...config,
    name,
    slug: "boilerplate",
    // Deep links: boilerplate://… opens the app (sign-in callbacks, invitations).
    scheme: "boilerplate",
    version: "0.1.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    runtimeVersion: { policy: "appVersion" },
    ios: {
      bundleIdentifier: `com.boilerplate.app${suffix}`,
      supportsTablet: true,
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
      ...(iosHost && {
        associatedDomains: [`applinks:${iosHost}`, `webcredentials:${iosHost}`],
      }),
    },
    android: {
      package: `com.boilerplate.app${suffix}`,
      adaptiveIcon: {
        backgroundColor: "#ffffff",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      // The paths match the site's assetlinks.json (apps/web/src/lib/app-links.ts); a link
      // to any other page stays in the browser.
      ...(androidHost && {
        intentFilters: [
          {
            action: "VIEW",
            autoVerify: true,
            data: [{ scheme: "https", host: androidHost, pathPrefix: "/invitations/" }],
            category: ["BROWSABLE", "DEFAULT"],
          },
        ],
      }),
    },
    web: { favicon: "./assets/favicon.png", output: "single" },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-localization",
      ["expo-notifications", { icon: "./assets/android-icon-monochrome.png" }],
      [
        "expo-splash-screen",
        { image: "./assets/splash-icon.png", imageWidth: 200, backgroundColor: "#ffffff" },
      ],
    ],
    experiments: { typedRoutes: true },
    ...(projectId && {
      extra: { eas: { projectId } },
      updates: { url: `https://u.expo.dev/${projectId}` },
    }),
  };
};
