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
 * Emails (sign-in codes, security alerts) are never sent from here. They are queued for the
 * notification service, rendered in the recipient's language, and delivered with
 * retries, so a slow email provider can never slow down or fail a sign-in.
 *
 * After adding or removing a plugin, regenerate the auth tables (db-change skill).
 */
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
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Env } from "../env";
import { features } from "../features";
import { type AuthContext, type AuthDependencies, authContext } from "./auth-context";
import { accountDeletion, databaseHooks, requestHooks } from "./auth-hooks";
import { captchaPlugins, emailOtpPlugin, organizationPlugin } from "./auth-plugins";
import { guestPlugins } from "./guest";

/** The product's name, as authenticator apps and passkey prompts show it. */
const APP_NAME = "Director";

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

/**
 * Google, when it's turned on and configured. Offline access, so Google hands back a
 * refresh token: publishing to YouTube (modules/publish) uses the member's access token
 * long after they signed in, and better-auth refreshes it with that. Sign-in asks for
 * the profile only; YouTube's upload permission is asked for when someone first publishes
 * (linkSocial with its scope), and Google adds it to what the account already granted.
 */
function socialProviders(env: Env) {
  return {
    ...(features.google &&
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET && {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          accessType: "offline" as const,
        },
      }),
  };
}

/**
 * Its arguments as a tuple, the type better-auth infers from a plugin list written inline:
 * it reads each plugin's own types (the organization plugin's session fields, for one)
 * from its position. A plain array would merge them into one union and lose those.
 */
const tuple = <T extends unknown[]>(...items: T) => items;

/** Every plugin, in the order better-auth runs their hooks. */
function plugins(context: AuthContext) {
  const { env } = context;
  return tuple(
    emailOtpPlugin(context),
    // Backup codes are encrypted at rest: stored as-is (the default), anyone reading
    // the table could get past a user's second factor.
    twoFactor({
      issuer: APP_NAME,
      backupCodeOptions: { amount: 10, storeBackupCodes: "encrypted" },
    }),
    // Passkeys are made and used on the site only.
    passkey({ rpID: new URL(env.WEB_URL).hostname, rpName: APP_NAME, origin: env.WEB_URL }),
    // Rejects passwords found in public breaches (k-anonymity: only a hash prefix is sent).
    haveIBeenPwned({ enabled: env.PASSWORD_BREACH_CHECK === "on" }),
    organizationPlugin(context),
    admin({ impersonationSessionDuration: 60 * MINUTE_S }),
    ...captchaPlugins(env),
    ...guestPlugins(context),
  );
}

export function createAuth({ database = undefined, ...dependencies }: AuthDependencies) {
  const { env, db, redis } = dependencies;
  const context = authContext(dependencies);

  const options = {
    appName: APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // When set, the newest signs and encrypts and BETTER_AUTH_SECRET decrypts older values.
    // Passed explicitly so only our parser (src/auth/secrets.ts) reads the variable.
    ...(env.BETTER_AUTH_SECRETS && { secrets: env.BETTER_AUTH_SECRETS }),
    // Browsers may only call auth endpoints from the site itself (CSRF protection).
    trustedOrigins: [env.WEB_URL],

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
