/**
 * Validated environment for the notification service. Shared variables come from
 * @repo/nest-common's fragments; add new ones here, to .env.example and to
 * docs/environment.md.
 */
import {
  coreEnv,
  databaseEnv,
  port,
  redisEnv,
  requiredInProduction,
  withServicePort,
} from "@repo/nest-common";
import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";
import { productionSmtpProblem } from "./channels/email/smtp-url";

/** @public Every variable, for the check that each is documented (scripts/env-docs.test.ts). */
export const envSchema = {
  ...coreEnv,
  ...databaseEnv("NOTIFICATIONS"),
  ...redisEnv,
  // Only serves health checks; the work arrives through the queues.
  PORT: port(3003),

  // Jobs one process handles at once, per queue. Scale out with more replicas.
  NOTIFICATIONS_CRITICAL_CONCURRENCY: z.coerce.number().int().positive().default(20),
  NOTIFICATIONS_BULK_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Local hour (in each user's time zone) from which their daily digest is sent.
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(8),

  // Where email is submitted: our Stalwart mail server in production (authenticated,
  // over TLS: see channels/email/smtp-url.ts), Mailpit locally.
  SMTP_URL: requiredInProduction(
    z.url({ protocol: /^smtps?$/ }).superRefine((value, context) => {
      const problem =
        process.env.NODE_ENV === "production" ? productionSmtpProblem(value) : undefined;
      if (problem) {
        context.addIssue({ code: "custom", message: problem });
      }
    }),
    "smtp://localhost:51025",
  ),
  EMAIL_FROM: requiredInProduction(z.string().min(3), "Boilerplate <no-reply@localhost>"),

  // The web app's public URL, for links in messages (settings, unsubscribe).
  WEB_URL: requiredInProduction(z.url(), "http://localhost:3000"),
  // Signs one-click unsubscribe links (apps/api verifies them with the same secret).
  UNSUBSCRIBE_SECRET: z.string().min(32),

  // Texts (security codes and alerts). twilio in production; locally "email" delivers
  // them to Mailpit as emails to <digits>@sms.test. Unset: nothing is texted.
  SMS_PROVIDER:
    process.env.NODE_ENV === "production"
      ? z.enum(["twilio", "email"]).optional()
      : z.enum(["twilio", "email"]).default("email"),
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  // A sender number (E.164) or a Messaging Service SID (MG...).
  TWILIO_FROM: z
    .string()
    .regex(/^(\+[1-9]\d{6,14}|MG[0-9a-f]{32})$/)
    .optional(),
  // Test hook: where Twilio's API lives.
  TWILIO_API_URL: z.url().optional(),

  // Push. Each platform is on when its variables are set (all of them, or none).
  // Android: a Firebase service account (Project settings → Service accounts).
  FCM_PROJECT_ID: z.string().min(1).optional(),
  FCM_CLIENT_EMAIL: z.email().optional(),
  FCM_PRIVATE_KEY: z.string().min(1).optional(),
  // iOS: an APNs auth key (.p8) from the Apple Developer account.
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_URL: z.url().default("https://api.push.apple.com"),
  // Browsers: VAPID keys (npx web-push generate-vapid-keys); the public one also goes to apps/api.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:)/)
    .optional(),
  // Test hooks: where FCM's token and send endpoints live (Google's by default).
  FCM_TOKEN_URL: z.url().optional(),
  FCM_API_URL: z.url().optional(),
  // Test hook: an origin accepted as a Web Push endpoint besides the browsers' services.
  WEB_PUSH_TEST_ORIGIN: z.url().optional(),
};

export const env = createEnv({
  server: envSchema,
  runtimeEnv: withServicePort("NOTIFICATIONS"),
  emptyStringAsUndefined: true,
});

// A misconfigured provider must fail at boot, not on the first message.
if (
  env.SMS_PROVIDER === "twilio" &&
  !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM)
) {
  throw new Error(
    "SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM",
  );
}

// Test hooks redirect providers to local servers, and the email sink is for local
// development; production must use the real providers.
if (
  env.NODE_ENV === "production" &&
  (env.FCM_TOKEN_URL ||
    env.FCM_API_URL ||
    env.WEB_PUSH_TEST_ORIGIN ||
    env.TWILIO_API_URL ||
    env.SMS_PROVIDER === "email")
) {
  throw new Error(
    "FCM_TOKEN_URL, FCM_API_URL, WEB_PUSH_TEST_ORIGIN, TWILIO_API_URL and SMS_PROVIDER=email are for development and tests only",
  );
}

/** Push platforms whose configuration is complete; a partial one fails at boot. */
export const pushPlatforms = {
  android: complete("FCM", [env.FCM_PROJECT_ID, env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY]),
  ios: complete("APNs", [
    env.APNS_KEY_ID,
    env.APNS_TEAM_ID,
    env.APNS_PRIVATE_KEY,
    env.APNS_BUNDLE_ID,
  ]),
  web: complete("Web Push", [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT]),
};

function complete(name: string, values: (string | undefined)[]) {
  const set = values.filter(Boolean).length;
  if (set !== 0 && set !== values.length) {
    throw new Error(`${name} needs all of its variables set, or none`);
  }
  return set === values.length;
}
