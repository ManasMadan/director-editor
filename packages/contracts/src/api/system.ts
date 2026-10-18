import * as z from "zod";
import { base } from "./base";

/**
 * Optional subsystems. A feature is on when its configuration is present (see
 * apps/api/src/features.ts). `demoGuests`: the demo gives each browser a private guest
 * (`/api/auth/sign-in/guest`), instead of only the shared demo account.
 */
const FEATURES = ["ai", "captcha", "demoGuests", "director", "files", "google", "live", "stock"] as const;
export type Feature = (typeof FEATURES)[number];

export const systemContract = {
  info: base
    .route({
      method: "GET",
      path: "/system",
      tags: ["System"],
      summary: "Enabled features and running release",
    })
    .output(
      z.object({
        release: z.string(),
        features: z.record(z.enum(FEATURES), z.boolean()),
        /** Oldest client version this API still supports; older apps must update. */
        minimumClientVersion: z.string(),
        /** Public Turnstile site key when captcha is on; clients render the widget with it. */
        captchaSiteKey: z.string().nullable(),
        /**
         * Director's shared demo account, for the sign-in page to sign in with, when this
         * environment has one (DEMO_PASSWORD set); null otherwise. Public on purpose:
         * anyone may try Director with it, and it can't publish or change its own account.
         * With `features.demoGuests` on, it's the fallback for when a guest can't be made.
         */
        demo: z.object({ email: z.email(), password: z.string() }).nullable(),
      }),
    ),
  alerting: base
    .route({
      method: "GET",
      path: "/system/alerting",
      tags: ["System"],
      summary: "Whether the cluster's alerting is alive",
    })
    .output(
      z.object({
        /**
         * `ok`: Alertmanager holds a recent Watchdog, the alert Prometheus always fires,
         * so both are running. `stale`: it doesn't, or doesn't answer. `off`: this
         * environment has no alerting. The dead man's switch outside the cluster
         * (scripts/uptime.ts) fails on `stale`.
         */
        status: z.enum(["ok", "stale", "off"]),
      }),
    ),
};
