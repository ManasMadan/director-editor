/**
 * Adding a phone number: the user asks for a code, we text it, they type it back. Only
 * then is the number saved, so a stored number is always one the user receives texts at.
 *
 * This is our own flow rather than better-auth's phoneNumber plugin because the plugin's
 * `send-otp` endpoint needs no session (anyone can make us text any number) and it adds
 * password reset by SMS, which makes a phone number enough to take over an account.
 *
 *   - Codes are random, stored hashed in Redis with the number they were sent to, expire
 *     after PHONE_CODE_EXPIRES_IN and allow MAX_ATTEMPTS guesses, counted atomically
 *     before comparing, so parallel guesses can't exceed it. Verifying is limited per
 *     user too.
 *   - Whether a number is on another account shows only when verifying it (the database's
 *     unique constraint), never when asking for a code: sending can't enumerate numbers.
 *   - Texts cost money and can be abused to spam a number (or to pump premium numbers),
 *     so sending needs a fresh session and is limited per user and per number.
 *   - Adding, changing or removing the number is audited and alerts the account's
 *     email (and the previous number, which is who needs to know it changed).
 */
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PHONE_CODE_EXPIRES_IN, PHONE_CODE_LENGTH } from "@repo/contracts/auth";
import type { UserId } from "@repo/contracts/ids";
import { HOUR_S, MINUTE_S } from "@repo/contracts/time";
import { transaction } from "@repo/db";
import { localeOrDefault } from "@repo/i18n";
import {
  AppError,
  createRateLimiter,
  type Database,
  InjectDatabase,
  InjectRedis,
  jobMetaFromContext,
  type Redis,
} from "@repo/nest-common";
import * as z from "zod";
import { env } from "../../env";
import {
  type CriticalNotifications,
  InjectCriticalNotifications,
  requestNotification,
} from "../../notifications";
import { emitEvent } from "../../outbox";
import { UserRepository } from "./user.repository";

const MAX_ATTEMPTS = 5;

const codeKey = (userId: UserId) => `phone-code:${userId}`;
const hashCode = (userId: UserId, code: string) =>
  createHash("sha256").update(`${userId}:${code}`).digest("hex");

@Injectable()
export class PhoneService {
  // Per user (sending and verifying) is declared in the contract; per number is here,
  // since the number is input.
  private readonly perNumber;

  constructor(
    @InjectDatabase() private readonly database: Database,
    private readonly users: UserRepository,
    @InjectRedis() private readonly redis: Redis,
    @InjectCriticalNotifications() private readonly notifications: CriticalNotifications,
  ) {
    // Fail closed: without Redis, no texts go out.
    this.perNumber = createRateLimiter(redis, {
      name: "phone-code-number",
      points: 3,
      windowSeconds: HOUR_S,
      onRedisError: "deny",
    });
  }

  async current(userId: UserId) {
    const user = await this.users.phoneNumber(userId);
    return user?.phoneNumber ?? null;
  }

  async sendCode(userId: UserId, locale: string | null | undefined, phoneNumber: string) {
    await this.perNumber.take(phoneNumber);
    // Its own number again: nothing to verify (and nothing learned about anyone else's).
    if ((await this.current(userId)) === phoneNumber) {
      throw new AppError("PHONE_NUMBER_TAKEN");
    }

    const code = String(randomInt(0, 10 ** PHONE_CODE_LENGTH)).padStart(PHONE_CODE_LENGTH, "0");
    // A new code replaces the previous one, attempts and all.
    const key = codeKey(userId);
    await this.redis
      .multi()
      .del(key)
      .hset(key, { phoneNumber, hash: hashCode(userId, code), attempts: 0 })
      .expire(key, PHONE_CODE_EXPIRES_IN)
      .exec();
    await this.notifications.add(
      "send",
      {
        template: "auth.phone-code",
        to: { phone: phoneNumber, locale: localeOrDefault(locale) },
        data: { code, expiresInMinutes: Math.round(PHONE_CODE_EXPIRES_IN / MINUTE_S) },
      },
      { jobId: randomUUID(), meta: jobMetaFromContext() },
    );
    return { expiresInSeconds: PHONE_CODE_EXPIRES_IN };
  }

  async verify(userId: UserId, phoneNumber: string, code: string) {
    const key = codeKey(userId);
    // Count the attempt before looking, atomically: of any number of parallel guesses,
    // only MAX_ATTEMPTS get compared. (On a missing key this creates a lone counter; it
    // has no hash, so it verifies nothing, and it expires below.)
    const [[, attempt], [, pending]] = z
      .tuple([
        z.tuple([z.null(), z.number()]),
        z.tuple([z.null(), z.record(z.string(), z.string())]),
      ])
      .parse(await this.redis.multi().hincrby(key, "attempts", 1).hgetall(key).exec());
    if (!pending.hash) {
      await this.redis.expire(key, PHONE_CODE_EXPIRES_IN);
      throw new AppError("PHONE_CODE_INVALID");
    }
    if (attempt > MAX_ATTEMPTS) {
      await this.redis.del(key);
      throw new AppError("PHONE_CODE_INVALID");
    }
    const matches =
      pending.phoneNumber === phoneNumber &&
      timingSafeEqual(Buffer.from(pending.hash, "hex"), Buffer.from(hashCode(userId, code), "hex"));
    if (!matches) {
      if (attempt === MAX_ATTEMPTS) {
        await this.redis.del(key);
      }
      throw new AppError("PHONE_CODE_INVALID");
    }
    // One use only, even if two requests race with the right code.
    if ((await this.redis.del(key)) === 0) {
      throw new AppError("PHONE_CODE_INVALID");
    }
    return this.change(userId, phoneNumber);
  }

  remove(userId: UserId) {
    return this.change(userId, null);
  }

  private async change(userId: UserId, phoneNumber: string | null) {
    return transaction(this.database.write, async (tx) => {
      const before = await this.users.phoneNumberIn(tx, userId);
      const updated = await this.users
        .setPhoneNumber(tx, userId, phoneNumber)
        .catch((error: { code?: string }) => {
          // Someone else verified this number in the meantime.
          if (error.code === "P2002") {
            throw new AppError("PHONE_NUMBER_TAKEN");
          }
          throw error;
        });
      const previous = before.phoneNumber;
      if (previous !== phoneNumber) {
        const origin = { actorId: userId, orgId: null };
        await emitEvent(
          tx,
          "auth.phone_changed.v1",
          userId,
          { userId, change: phoneNumber ? "added" : "removed" },
          origin,
        );
        // The number that was on the account: after a change, the old one hears of it.
        const notified = previous ?? phoneNumber;
        // With the change, in its transaction: sent exactly when it commits.
        await requestNotification(
          tx,
          userId,
          {
            template: "auth.security-alert",
            to: {
              email: updated.email,
              locale: localeOrDefault(updated.locale),
              ...(notified && { phone: notified }),
            },
            data: {
              event: phoneNumber ? "phone-added" : "phone-removed",
              securityUrl: new URL("/settings/security", env.WEB_URL).toString(),
            },
          },
          origin,
        );
      }
      return updated;
    });
  }
}
