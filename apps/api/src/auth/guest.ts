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
 * the worker's demo-retention task deletes it with its workspace, their files leave
 * storage and its sessions leave Valkey (auth.purge_expired_guests). Its address is on a
 * reserved domain, so nothing is ever mailed to it, and its name is "Guest" in its own
 * language. It gets less than a member: a smaller monthly AI allowance (the AI service's
 * AI_MONTHLY_TOKENS_PER_DEMO_GUEST) and fewer live calls an hour
 * (DEMO_GUEST_LIVE_CALLS_PER_HOUR, server.ts).
 *
 * Its session never outlives its day, whatever the browser sends: the session hook
 * clamps any new expiry to `guestUntil` (`clampToGuestDay`, auth-hooks.ts), so a refresh
 * can't stretch it, and Valkey's copy expires with it. It's made as better-auth's "don't
 * remember me" session, both cookies lasting the day, so an ordinary browser doesn't ask
 * for that refresh on every request.
 *
 * Abuse: Turnstile on the sign-in while captcha is on (auth-plugins.ts, invisible to a
 * person), DEMO_GUESTS_PER_ADDRESS guests an hour from one address (better-auth's rate
 * limiter, per client IP), and DEMO_GUEST_LIMIT guests at once in all (DEMO_GUESTS_FULL
 * past it), counted atomically in Valkey so a burst can't overshoot it.
 */
import { randomUUID } from "node:crypto";
import { DEMO_GUEST_LIFETIME_S } from "@repo/contracts/auth";
import type { AuthErrorCode } from "@repo/contracts/errors";
import { fieldOf, required } from "@repo/contracts/objects";
import { HOUR_S, SECOND_MS } from "@repo/contracts/time";
import type { Db } from "@repo/db";
import { bundledMessages, createI18n, negotiateLocale } from "@repo/i18n";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { Redis } from "ioredis";
import * as z from "zod";
import { features } from "../features";
import type { AuthContext } from "./auth-context";

/** Where the web app's "Try it now" signs in. */
export const GUEST_SIGN_IN_PATH = "/sign-in/guest";

/** RFC 2606 reserves `.invalid`: no address on it can receive mail, or ever be anyone's. */
const GUEST_EMAIL_DOMAIN = "guest.invalid";

/** The live guests' places in Valkey: each guest's id, scored by when its day ends (ms). */
const LIVE_GUESTS_KEY = "demo:live-guests";

/**
 * Takes a place for a new guest if fewer than `limit` guests are live, in one step: the
 * places whose day is over are dropped, the rest counted, and the new one added, all in
 * one script, which Valkey runs alone, so concurrent sign-ins can't both see the last
 * place free. The key itself expires with the last place in it. Valkey holds the count,
 * and Postgres the guests: when Valkey loses it, recountWhenLost puts it back first.
 */
const TAKE_PLACE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 1`;

const i18n = createI18n(bundledMessages);

/** A new guest's address: unique, and never a real mailbox. */
const guestEmail = () => `guest-${randomUUID()}@${GUEST_EMAIL_DOMAIN}`;

/** When a guest made `now` is deleted. */
const guestUntilFrom = (now: Date) => new Date(now.getTime() + DEMO_GUEST_LIFETIME_S * SECOND_MS);

/**
 * Puts the live guests' places back, only while there are none: a sign-in that took a
 * place in the meantime made the key, and its guest may already be among those read from
 * Postgres, so adding them then would count it twice.
 */
const RESTORE_PLACES = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('ZADD', KEYS[1], unpack(ARGV))
return 1`;

/**
 * Puts the live guests back in Valkey when their places are gone (Valkey restarted without
 * its data, or was emptied), counted from Postgres, so losing Valkey's data can't free
 * every place at once.
 */
async function recountWhenLost(db: Db, redis: Redis) {
  if (await redis.exists(LIVE_GUESTS_KEY)) {
    return;
  }
  const live = await db.user.findMany({
    where: { guestUntil: { gt: new Date() } },
    select: { id: true, guestUntil: true },
  });
  const places = live.flatMap(({ id, guestUntil }) => [
    required(guestUntil, "a live guest's day").getTime(),
    id,
  ]);
  if (places.length > 0) {
    await redis.eval(RESTORE_PLACES, 1, LIVE_GUESTS_KEY, ...places);
  }
}

/** Takes a place among the live guests for a guest about to be made; throws when there's none. */
async function takePlace(
  { db, redis }: Pick<AuthContext, "db" | "redis">,
  until: Date,
  limit: number,
) {
  await recountWhenLost(db, redis);
  const taken = z
    .number()
    .parse(
      await redis.eval(
        TAKE_PLACE,
        1,
        LIVE_GUESTS_KEY,
        Date.now(),
        until.getTime(),
        limit,
        randomUUID(),
      ),
    );
  if (taken !== 1) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "DEMO_GUESTS_FULL" satisfies AuthErrorCode,
      message: "The demo has as many guests as it can take.",
    });
  }
}

/**
 * A session update as the session hook gets it, with its expiry no later than its
 * guest's `guestUntil`: refreshing a session moves its expiry on (by better-auth's 7 days),
 * which a guest's mustn't. Anyone else's update, and one that doesn't move the expiry,
 * comes back as it was. `user` is the session's, as the request found it.
 */
export function clampToGuestDay<T extends { expiresAt?: Date | undefined }>(
  update: T,
  user: unknown,
): T {
  const until = z.coerce.date().nullish().parse(fieldOf(user, "guestUntil"));
  if (!until || !update.expiresAt || update.expiresAt <= until) {
    return update;
  }
  return { ...update, expiresAt: until };
}

/** What the browser may say about its guest: its time zone, for the dates it's shown. */
const guestBody = z.object({ timezone: z.string().max(100).optional() });

function guestPlugin({ db, env, redis }: AuthContext) {
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
          const guestUntil = guestUntilFrom(new Date());
          await takePlace({ db, redis }, guestUntil, env.DEMO_GUEST_LIMIT);
          const locale = negotiateLocale(
            ctx.headers?.get("x-locale") ?? ctx.headers?.get("accept-language"),
          );
          const t = await i18n.getTranslator(locale);
          const { internalAdapter, authCookies, secret } = ctx.context;
          // Should this fail (the database), the place stays taken until its day ends:
          // the cap errs on the side of fewer guests.
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
