/**
 * Per-account limits on the endpoints that guess or send secrets, next to better-auth's
 * per-address ones (auth.ts `rateLimit`). A client address can be forged or rotated, so
 * an address limit alone doesn't stop someone trying passwords, second factors or codes
 * against one account from many addresses. These count per account (the normalised
 * email, or for a second factor the sign-in attempt's two-factor cookie) and fail
 * closed: if Redis can't answer, the attempt is refused.
 *
 * The cost is that someone can lock an account out of these endpoints for the window by
 * spending its attempts; a passkey or an existing session still works meanwhile.
 */
import { createHash } from "node:crypto";
import { fieldOf } from "@repo/contracts/objects";
import { HOUR_S } from "@repo/contracts/time";
import { createRateLimiter, type Redis } from "@repo/nest-common";
import { APIError } from "better-auth/api";

const QUARTER_HOUR = 15 * 60;

interface Limit {
  /** Attempts per window, per account. */
  points: number;
  windowSeconds: number;
  /** What identifies the account in the request. */
  by: "email" | "second factor";
}

/** better-auth paths and their limits. */
export const ACCOUNT_LIMITS: Record<string, Limit> = {
  "/sign-in/email": { points: 10, windowSeconds: QUARTER_HOUR, by: "email" },
  "/email-otp/send-verification-otp": { points: 5, windowSeconds: QUARTER_HOUR, by: "email" },
  "/forget-password/email-otp": { points: 5, windowSeconds: QUARTER_HOUR, by: "email" },
  "/email-otp/reset-password": { points: 10, windowSeconds: QUARTER_HOUR, by: "email" },
  "/email-otp/verify-email": { points: 10, windowSeconds: QUARTER_HOUR, by: "email" },
  "/two-factor/verify-totp": { points: 10, windowSeconds: QUARTER_HOUR, by: "second factor" },
  "/two-factor/verify-backup-code": {
    points: 10,
    windowSeconds: QUARTER_HOUR,
    by: "second factor",
  },
  "/two-factor/verify-otp": { points: 10, windowSeconds: QUARTER_HOUR, by: "second factor" },
  "/two-factor/send-otp": { points: 5, windowSeconds: QUARTER_HOUR, by: "second factor" },
};

/** What the hook reads from better-auth's request context. */
export interface LimitedRequest {
  path: string;
  body?: unknown;
  /** The two-factor cookie's raw value, when there is one. */
  secondFactor?: string;
}

/** The account a request is about, or undefined when it names none (it then fails validation). */
export function accountKey(limit: Limit, request: LimitedRequest): string | undefined {
  if (limit.by === "second factor") {
    return request.secondFactor
      ? createHash("sha256").update(request.secondFactor).digest("hex")
      : undefined;
  }
  const email = fieldOf(request.body, "email");
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : undefined;
}

/** Consumes the request's account limit; throws 429 (RATE_LIMITED to clients) past it. */
export function createAccountLimits(redis: Redis) {
  const limiters = new Map(
    Object.entries(ACCOUNT_LIMITS).map(([path, limit]) => [
      path,
      {
        limit,
        limiter: createRateLimiter(redis, {
          name: `auth-account${path.replaceAll("/", ":")}`,
          points: limit.points,
          windowSeconds: limit.windowSeconds,
          onRedisError: "deny",
        }),
      },
    ]),
  );
  return async function check(request: LimitedRequest) {
    const entry = limiters.get(request.path);
    if (!entry) {
      return;
    }
    const key = accountKey(entry.limit, request);
    if (!key) {
      return;
    }
    const result = await entry.limiter.consume(key);
    if (!result.allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        message: "Too many attempts for this account; try again later.",
        code: "RATE_LIMITED",
      });
    }
  };
}

/**
 * Emails our domain sends to an address someone else typed: sign-in and verification
 * codes, and invitations. Limited where they're sent, whatever endpoint asked, per
 * recipient (nobody gets flooded) and per inviter (no account becomes a spam cannon),
 * failing closed like the limits above.
 */
export const EMAIL_LIMITS = {
  /** Codes to one address, for any purpose. */
  codesPerRecipient: { points: 10, windowSeconds: HOUR_S },
  invitationsPerRecipient: { points: 3, windowSeconds: 24 * HOUR_S },
  invitationsPerInviter: { points: 30, windowSeconds: HOUR_S },
};

export function createEmailLimits(redis: Redis) {
  const limiter = (name: keyof typeof EMAIL_LIMITS) =>
    createRateLimiter(redis, {
      name: `email:${name}`,
      ...EMAIL_LIMITS[name],
      onRedisError: "deny",
    });
  const limiters = {
    codesPerRecipient: limiter("codesPerRecipient"),
    invitationsPerRecipient: limiter("invitationsPerRecipient"),
    invitationsPerInviter: limiter("invitationsPerInviter"),
  };
  const refuse = () => {
    throw new APIError("TOO_MANY_REQUESTS", {
      message: "Too many emails; try again later.",
      code: "RATE_LIMITED",
    });
  };
  const address = (email: string) => email.trim().toLowerCase();
  return {
    async code(email: string) {
      if (!(await limiters.codesPerRecipient.consume(address(email))).allowed) {
        refuse();
      }
    },
    async invitation(inviterId: string, email: string) {
      if (!(await limiters.invitationsPerInviter.consume(inviterId)).allowed) {
        refuse();
      }
      if (!(await limiters.invitationsPerRecipient.consume(address(email))).allowed) {
        refuse();
      }
    },
  };
}
