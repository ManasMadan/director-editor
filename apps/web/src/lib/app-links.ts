/**
 * The files iOS and Android read from this site before they let the mobile app open its
 * https links (universal links, App Links) and use its passkeys: built from the app's
 * identifiers in the environment, so each deployment names the build that talks to it.
 * The feature is optional: with none of the four variables set both answer 404, never a
 * file with made-up ids.
 *
 * The paths the app opens match `intentFilters` in apps/mobile/app.config.ts: a link to
 * any other page stays in the browser.
 */
import { env } from "@/env";

const APP_PATHS = ["/invitations/*"];

const VARIABLES = [
  "APPLE_TEAM_ID",
  "IOS_BUNDLE_ID",
  "ANDROID_PACKAGE",
  "ANDROID_CERT_FINGERPRINTS",
] as const;
type AppEnv = Pick<typeof env, (typeof VARIABLES)[number]>;

/**
 * The mobile app's identifiers: undefined when none is set (the feature is off), and an
 * error naming the missing ones when only some are, so a half-configured site stops at
 * boot (src/instrumentation.ts) instead of serving half the files.
 */
export function mobileApp(config: AppEnv = env) {
  const missing = VARIABLES.filter((name) => !config[name]);
  if (missing.length === VARIABLES.length) {
    return undefined;
  }
  const { APPLE_TEAM_ID, IOS_BUNDLE_ID, ANDROID_PACKAGE, ANDROID_CERT_FINGERPRINTS } = config;
  if (!(APPLE_TEAM_ID && IOS_BUNDLE_ID && ANDROID_PACKAGE && ANDROID_CERT_FINGERPRINTS)) {
    throw new Error(
      `The mobile app's links and passkeys need all four of APPLE_TEAM_ID, IOS_BUNDLE_ID, ` +
        `ANDROID_PACKAGE and ANDROID_CERT_FINGERPRINTS set, or none; missing: ${missing.join(", ")}`,
    );
  }
  return {
    appId: `${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`,
    androidPackage: ANDROID_PACKAGE,
    fingerprints: ANDROID_CERT_FINGERPRINTS,
  };
}

/** `/.well-known/apple-app-site-association`: links (applinks) and passkeys (webcredentials). */
export function appleAppSiteAssociation(config?: AppEnv) {
  const app = mobileApp(config);
  if (!app) {
    return new Response(null, { status: 404 });
  }
  // Response.json sets the application/json type Apple requires for this extensionless file.
  return Response.json({
    applinks: {
      details: [{ appIDs: [app.appId], components: APP_PATHS.map((path) => ({ "/": path })) }],
    },
    webcredentials: { apps: [app.appId] },
  });
}

/** `/.well-known/assetlinks.json`: links (handle_all_urls) and passkeys (get_login_creds). */
export function assetLinks(config?: AppEnv) {
  const app = mobileApp(config);
  if (!app) {
    return new Response(null, { status: 404 });
  }
  return Response.json([
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: app.androidPackage,
        sha256_cert_fingerprints: app.fingerprints,
      },
    },
  ]);
}
