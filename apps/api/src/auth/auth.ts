/**
 * Authentication (better-auth): the one place sign-in, sessions, organizations and
 * account security are configured. Clients use the better-auth client from
 * packages/client; oRPC procedures read the session through the `authed` middleware.
 * The hooks are in auth-hooks.ts and the larger plugins in auth-plugins.ts; what they
 * share is in auth-context.ts.
 *
 * Sessions are server-side and revocable. Each session lives in Redis (fast lookups on
 * every request) with a durable copy in Postgres (device list, audit). There is no
 * cookie cache: signing out or revoking a session deletes it, so the same cookie is
 * rejected on the very next request.
 *
 * Emails (sign-in codes, invitations) are never sent from here. They are queued for the
 * notification service, rendered in the recipient's language, and delivered with
 * retries, so a slow email provider can never slow down or fail a sign-in.
 *
 * After adding or removing a plugin, regenerate the auth tables (db-change skill).
 */
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { passkey } from "@better-auth/passkey";
import { redisStorage } from "@better-auth/redis-storage";
import {
  FRESH_SESSION_AGE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  userAdditionalFields,
} from "@repo/contracts/auth";
import { DAY_S, MINUTE_S } from "@repo/contracts/time";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins/admin";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { jwt } from "better-auth/plugins/jwt";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Env } from "../env";
import { features } from "../features";
import { type AuthContext, type AuthDependencies, authContext } from "./auth-context";
import { accountDeletion, databaseHooks, requestHooks } from "./auth-hooks";
import {
  apiKeyPlugin,
  captchaPlugins,
  emailOtpPlugin,
  mcpPlugin,
  organizationPlugin,
} from "./auth-plugins";
import { mobileSignIn } from "./mobile-sign-in";

/** The API key plugin's own endpoints, all turned off (see `disabledPaths`). */
const API_KEY_PLUGIN_PATHS = [
  "/api-key/create",
  "/api-key/get",
  "/api-key/update",
  "/api-key/delete",
  "/api-key/list",
];
/** The mobile app's URL scheme (apps/mobile app.config.ts). */
const MOBILE_SCHEME = "boilerplate";

const SESSION = {
  expiresIn: 7 * DAY_S,
  // Sliding expiry: an active session is extended at most once a day.
  updateAge: DAY_S,
  // Keep the durable copy so users can see and revoke their devices.
  storeSessionInDatabase: true,
  // "Sudo mode": listing devices, adding a passkey and unlinking a social account need a
  // session signed in within this window (better-auth's fresh-session rule); after it,
  // the web app asks the user to sign in again. Password, 2FA and account deletion always
  // ask for the password, and email changes need emailed codes.
  freshAge: FRESH_SESSION_AGE,
  // Deliberately no cookieCache: a cached session would outlive sign-out/revocation.
} satisfies BetterAuthOptions["session"];

const RATE_LIMIT = {
  enabled: true,
  storage: "secondary-storage",
  window: MINUTE_S,
  max: 100,
  // Brute-force protection on the endpoints that guess secrets.
  customRules: {
    "/sign-in/email": { window: MINUTE_S, max: 5 },
    "/sign-up/email": { window: MINUTE_S, max: 5 },
    "/email-otp/*": { window: MINUTE_S, max: 5 },
    "/two-factor/*": { window: MINUTE_S, max: 5 },
    "/forget-password/*": { window: MINUTE_S, max: 3 },
    // Anyone may register an MCP client (it still needs a user's consent to get a token),
    // so registration is limited per address.
    "/oauth2/register": { window: MINUTE_S, max: 5 },
  },
} satisfies BetterAuthOptions["rateLimit"];

const EMAIL_AND_PASSWORD = {
  enabled: true,
  minPasswordLength: PASSWORD_MIN_LENGTH,
  maxPasswordLength: PASSWORD_MAX_LENGTH,
  // No session until the email is verified; every authenticated user has a real address.
  requireEmailVerification: true,
  // A password reset signs out every device (the reset might be recovering a stolen account).
  revokeSessionsOnPasswordReset: true,
} satisfies BetterAuthOptions["emailAndPassword"];

/** Google, when it's turned on and configured. */
function socialProviders(env: Env) {
  return {
    ...(features.google &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET && {
        google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      }),
  };
}

/**
 * Where passkeys may be made and used: the site, the product's other origins (the
 * mobile app's web build) and the Android app. iOS reports the site's origin for the app
 * too (its associated domain), but Android's Credential Manager reports the app's own,
 * `android:apk-key-hash:` and its signing certificate's SHA-256 in base64url.
 */
export function passkeyOrigins(
  env: Pick<Env, "WEB_URL" | "APP_ORIGINS" | "ANDROID_CERT_FINGERPRINTS">,
) {
  const app = env.ANDROID_CERT_FINGERPRINTS.map(
    (fingerprint) =>
      `android:apk-key-hash:${Buffer.from(fingerprint.replaceAll(":", ""), "hex").toString("base64url")}`,
  );
  return [env.WEB_URL, ...env.APP_ORIGINS, ...app];
}

/**
 * Its arguments as a tuple, the type better-auth infers from a plugin list written inline:
 * it reads each plugin's own types (the organization plugin's session fields, for one)
 * from its position. A plain array would merge them into one union and lose those.
 */
const tuple = <T extends unknown[]>(...items: T) => items;

/** Every plugin, in the order better-auth runs their hooks. */
function plugins(context: AuthContext) {
  const { env, redis } = context;
  return tuple(
    // The mobile app: it sends its origin in a header of its own (native requests have
    // none), Expo Go's exp:// is trusted in development, and social sign-in hands the
    // session over without putting it in a link (mobile-sign-in.ts).
    mobileSignIn(redis),
    emailOtpPlugin(context),
    // Backup codes are encrypted at rest: stored as-is (the default), anyone reading
    // the table could get past a user's second factor.
    twoFactor({
      issuer: "Boilerplate",
      backupCodeOptions: { amount: 10, storeBackupCodes: "encrypted" },
    }),
    passkey({
      rpID: new URL(env.WEB_URL).hostname,
      rpName: "Boilerplate",
      origin: passkeyOrigins(env),
    }),
    // Rejects passwords found in public breaches (k-anonymity: only a hash prefix is sent).
    haveIBeenPwned({ enabled: env.PASSWORD_BREACH_CHECK === "on" }),
    organizationPlugin(context),
    admin({ impersonationSessionDuration: 60 * MINUTE_S }),
    apiKeyPlugin(),
    // Signing keys for OAuth access tokens, published at /api/auth/jwks so each MCP
    // server verifies tokens itself. Keys rotate; old ones stay published for the grace
    // period so tokens signed just before a rotation still verify.
    jwt({
      jwks: { rotationInterval: 90 * DAY_S, gracePeriod: 30 * DAY_S },
      // Sessions stay cookies; only the OAuth flow issues JWTs.
      disableSettingJwtHeader: true,
    }),
    mcpPlugin(context),
    // Client ID Metadata Documents (the MCP 2026-07-28 way): a client's id is a URL to
    // its metadata, fetched through a transport that resolves DNS once, refuses private
    // addresses and never follows redirects (no SSRF).
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ...captchaPlugins(env),
  );
}

export function createAuth({ database = undefined, ...dependencies }: AuthDependencies) {
  const { env, db, redis } = dependencies;
  const context = authContext(dependencies);

  const options = {
    appName: "Boilerplate",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // When set, the newest signs and encrypts and BETTER_AUTH_SECRET decrypts older values.
    ...(env.BETTER_AUTH_SECRETS && { secrets: env.BETTER_AUTH_SECRETS }),
    // Browsers may only call auth endpoints from the product's own origins (CSRF
    // protection); the mobile app's scheme is added by the Expo plugin below.
    trustedOrigins: [env.WEB_URL, ...env.APP_ORIGINS, `${MOBILE_SCHEME}://`],
    // The JWT plugin's /token would hand any session a signed JWT; access tokens come only
    // from the OAuth flow below. API keys are managed through the API's own procedures
    // (apps/api/src/modules/api-keys: typed, audited, with scopes), so the plugin's
    // endpoints aren't served.
    disabledPaths: ["/token", ...API_KEY_PLUGIN_PATHS],

    database: database ?? prismaAdapter(db, { provider: "postgresql" }),
    // Session lookups hit Redis, not Postgres, on every request.
    secondaryStorage: redisStorage({ client: redis, keyPrefix: "auth:" }),
    advanced: {
      // Ids come from Postgres (uuidv7() defaults), like every other table.
      database: { generateId: false },
      // Behind the gateway, the client IP arrives in X-Forwarded-For (trusted proxies only).
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    session: SESSION,
    rateLimit: RATE_LIMIT,
    emailAndPassword: EMAIL_AND_PASSWORD,
    emailVerification: {
      // Trying to sign in unverified sends a fresh code, so lost emails are self-service.
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
    },
    user: {
      // locale + timezone: captured from the browser at sign-up and normalised in the
      // database hooks. Shared with clients so they're typed there too.
      additionalFields: userAdditionalFields,
      deleteUser: accountDeletion(context),
      // Email changes go only through the code-based flow in emailOTP; the link-based
      // /change-email endpoint stays off so there's one audited path.
    },
    account: {
      // OAuth access/refresh tokens are encrypted at rest.
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    socialProviders: socialProviders(env),
    hooks: requestHooks(context),
    databaseHooks: databaseHooks(context),

    plugins: plugins(context),
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
