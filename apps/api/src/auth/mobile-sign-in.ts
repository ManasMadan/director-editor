/**
 * Social sign-in on the mobile app, without the session ever riding in a link.
 *
 * The flow ends in a redirect to the app's scheme (`boilerplate://`), and better-auth's
 * Expo plugin puts the session cookie in that redirect (`?cookie=`). A custom scheme isn't
 * verified: on Android any app can register the same one and catch the link. So this
 * keeps the Expo plugin (its origin header and its authorization proxy) but replaces its
 * cookie hand-off with one only the app that started the sign-in can complete:
 *
 *   1. the app asks for a hand-off (`POST /mobile/sign-in/start`) and gets an id and a
 *      secret, over its own HTTPS connection;
 *   2. it signs in with the id in its callback URL (`boilerplate://…?handoff=<id>`);
 *   3. when the callback redirects there, the session is kept under the id, and the link
 *      carries only the id;
 *   4. the app trades the id and the secret for the session (`POST /mobile/sign-in/finish`),
 *      once. Whoever catches the link has the id, never the secret.
 *
 * A redirect to the scheme without a hand-off carries no session at all.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { expo } from "@better-auth/expo";
import type { AuthErrorCode } from "@repo/contracts/errors";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import type { Redis } from "ioredis";
import * as z from "zod";

/** Long enough to sign in at the provider (its state lasts 10 minutes). */
const HANDOFF_SECONDS = 10 * 60;
const token = () => randomBytes(32).toString("base64url");
const digest = (secret: string) => createHash("sha256").update(secret).digest();
const key = (id: string) => `auth:mobile-handoff:${id}`;

/** What Redis keeps per hand-off: the secret's hash, then the session's cookies too. */
const stored = z.object({ secret: z.string(), cookie: z.string().optional() });
const handoffId = z.string().regex(/^[\w-]{43}$/);

type AfterHook = NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["after"]>[number];

/** After a social sign-in's callback: keeps its session under the hand-off its link names. */
function keepForHandoff(redis: Redis): AfterHook {
  return {
    matcher: (context) => context.path?.startsWith("/callback") === true,
    handler: createAuthMiddleware(async (ctx) => {
      // Only a sign-in that made a session has one to hand over (a refused or failed
      // one redirects too, with an error).
      const headers = ctx.context.responseHeaders;
      const target = URL.parse(String(headers?.get("location")));
      const cookie = headers?.get("set-cookie");
      if (!ctx.context.newSession || !target) {
        return;
      }
      if (target.protocol === "http:" || target.protocol === "https:") {
        return;
      }
      const id = handoffId.safeParse(target.searchParams.get("handoff"));
      if (!id.success) {
        return;
      }
      const record = stored.safeParse(JSON.parse((await redis.get(key(id.data))) ?? "null"));
      if (!record.success) {
        return;
      }
      await redis.set(
        key(id.data),
        JSON.stringify({ ...record.data, cookie }),
        "EX",
        HANDOFF_SECONDS,
        "XX",
      );
    }),
  };
}

export function mobileSignIn(redis: Redis) {
  const base = expo();
  const failed = () =>
    new APIError("UNAUTHORIZED", {
      message: "The sign-in couldn't be completed. Please try again.",
      code: "SIGN_IN_INCOMPLETE" satisfies AuthErrorCode,
    });

  return {
    ...base,
    hooks: {
      after: [keepForHandoff(redis)],
    },
    endpoints: {
      ...base.endpoints,
      mobileSignInStart: createAuthEndpoint(
        "/mobile/sign-in/start",
        { method: "POST" },
        async (ctx) => {
          const id = token();
          const secret = token();
          await redis.set(
            key(id),
            JSON.stringify({ secret: digest(secret).toString("base64url") }),
            "EX",
            HANDOFF_SECONDS,
          );
          return ctx.json({ id, secret });
        },
      ),
      mobileSignInFinish: createAuthEndpoint(
        "/mobile/sign-in/finish",
        { method: "POST", body: z.object({ id: handoffId, secret: z.string().max(100) }) },
        async (ctx) => {
          // Taken whatever happens next: one attempt per hand-off.
          const record = stored.safeParse(
            JSON.parse((await redis.getdel(key(ctx.body.id))) ?? "null"),
          );
          if (!record.success || !record.data.cookie) {
            throw failed();
          }
          const expected = Buffer.from(record.data.secret, "base64url");
          if (!timingSafeEqual(expected, digest(ctx.body.secret))) {
            throw failed();
          }
          // The callback's cookies, as one header: the app's client reads them from it.
          ctx.setHeader("set-cookie", record.data.cookie);
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
