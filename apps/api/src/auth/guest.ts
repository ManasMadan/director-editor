/**
 * Director's demo guests: one tap on "Try it now" signs the browser in as a guest of its
 * own, so judges trying Director never see each other's takes, videos or chatter (the
 * shared demo account in demo.ts would show everyone's to everyone). On while DEMO_GUESTS
 * is "on" (`features.demoGuests`).
 *
 * A guest is an ordinary user made through better-auth's adapter, so the sign-up hooks
 * run: its personal workspace, with the seeded templates, comes with it. It's flagged
 * `demo`, so every restriction on the shared account holds for it too (no publishing, no
 * changes to the account, no passkey or Google account linked to something that's about
 * to go), and `guestUntil` says when it goes: DEMO_GUEST_LIFETIME_S after it was made,
 * the worker's demo-guests task deletes it with its workspace, and their files leave
 * storage with them (auth.purge_expired_guests). Its address is on a reserved domain,
 * so nothing is ever mailed to it, and its name is "Guest" in its own language.
 *
 * Its session lasts exactly as long as it does, and is never extended: it's made as
 * better-auth's "don't remember me" session, which better-auth doesn't refresh, ending at
 * `guestUntil`, and both cookies carry the same lifetime, so closing the browser doesn't
 * drop the "don't remember" mark and leave a session to be stretched past the guest's
 * day. Nothing signed in outlives what the worker deletes.
 *
 * Abuse: DEMO_GUESTS_PER_ADDRESS guests an hour from one address (better-auth's rate
 * limiter, per client IP), and DEMO_GUEST_LIMIT guests at once in all (DEMO_GUESTS_FULL
 * past it). Two requests racing at the limit may both get one: the cap bounds storage
 * and cost roughly, and one over doesn't matter.
 */
import { randomUUID } from "node:crypto";
import { DEMO_GUEST_LIFETIME_S } from "@repo/contracts/auth";
import type { AuthErrorCode } from "@repo/contracts/errors";
import { HOUR_S, SECOND_MS } from "@repo/contracts/time";
import type { Db } from "@repo/db";
import { bundledMessages, createI18n, negotiateLocale } from "@repo/i18n";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import { features } from "../features";
import type { AuthContext } from "./auth-context";

/** Where the web app's "Try it now" signs in. */
const GUEST_SIGN_IN_PATH = "/sign-in/guest";

/** RFC 2606 reserves `.invalid`: no address on it can receive mail, or ever be anyone's. */
const GUEST_EMAIL_DOMAIN = "guest.invalid";

const i18n = createI18n(bundledMessages);

/** A new guest's address: unique, and never a real mailbox. */
const guestEmail = () => `guest-${randomUUID()}@${GUEST_EMAIL_DOMAIN}`;

/** When a guest made `now` is deleted. */
const guestUntilFrom = (now: Date) =>
  new Date(now.getTime() + DEMO_GUEST_LIFETIME_S * SECOND_MS);

/** Refuses another guest while `limit` are still live. */
async function refuseWhenFull(db: Db, limit: number) {
  const live = await db.user.count({ where: { guestUntil: { gt: new Date() } } });
  if (live >= limit) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "DEMO_GUESTS_FULL" satisfies AuthErrorCode,
      message: "The demo has as many guests as it can take.",
    });
  }
}

/** What the browser may say about its guest: its time zone, for the dates it's shown. */
const guestBody = z.object({ timezone: z.string().max(100).optional() });

function guestPlugin({ db, env }: AuthContext) {
  return {
    id: "demo-guest",
    endpoints: {
      signInGuest: createAuthEndpoint(
        GUEST_SIGN_IN_PATH,
        { method: "POST", body: guestBody },
        async (ctx) => {
          // Already signed in (a guest coming back to its day, or a member): nothing to
          // make, and nobody is swapped out of their own account.
          if (await getSessionFromCtx(ctx, { disableRefresh: true })) {
            return ctx.json({ created: false });
          }
          await refuseWhenFull(db, env.DEMO_GUEST_LIMIT);
          const guestUntil = guestUntilFrom(new Date());
          const locale = negotiateLocale(
            ctx.headers?.get("x-locale") ?? ctx.headers?.get("accept-language"),
          );
          const t = await i18n.getTranslator(locale);
          const { internalAdapter, authCookies, secret } = ctx.context;
          const user = await internalAdapter.createUser(
            {
              email: guestEmail(),
              name: t("auth.guest.name"),
              demo: true,
              guestUntil,
              locale,
              timezone: ctx.body.timezone,
            },
            { method: "anonymous" },
          );
          const session = await internalAdapter.createSession(
            user.id,
            true,
            { expiresAt: guestUntil },
            true,
          );
          const maxAge = DEMO_GUEST_LIFETIME_S;
          await setSessionCookie(ctx, { session, user }, true, { maxAge });
          await ctx.setSignedCookie(authCookies.dontRememberToken.name, "true", secret, {
            ...authCookies.dontRememberToken.attributes,
            maxAge,
          });
          return ctx.json({ created: true });
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === GUEST_SIGN_IN_PATH,
        window: HOUR_S,
        max: env.DEMO_GUESTS_PER_ADDRESS,
      },
    ],
  } satisfies BetterAuthPlugin;
}

/** The guest sign-in, while the demo gives guests out (`features.demoGuests`). */
export function guestPlugins(context: AuthContext) {
  return features.demoGuests ? [guestPlugin(context)] : [];
}
