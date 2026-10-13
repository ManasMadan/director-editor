/**
 * Daily digests: users on the digest get their non-urgent email as one summary a day,
 * once it's DIGEST_HOUR or later in their time zone.
 *
 * An hourly job (a BullMQ scheduler, so it runs once whatever the replica count) queues
 * one `digest` job per user with items waiting. Each digest is claimed in the delivery
 * log per user and local date, so a user gets at most one a day; a digest missed while
 * the service was down still goes out later that day. Items that arrive after that
 * day's digest wait for the next one.
 */

import { InjectQueue } from "@nestjs/bullmq";
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { type UserId, userIdSchema } from "@repo/contracts/ids";
import { withUser } from "@repo/db";
import { DigestEmail, digestSubject, renderEmail } from "@repo/email";
import { loosely } from "@repo/i18n";
import { createProducer, type QueueOf } from "@repo/jobs";
import {
  type Database,
  type I18n,
  InjectDatabase,
  InjectI18n,
  InjectPinoLogger,
  InjectRedis,
  PinoLogger,
  type Redis,
  rows,
} from "@repo/nest-common";
import * as z from "zod";
import { EmailChannel } from "../channels/email/email.channel";
import { DeliveryLog } from "../dispatch/delivery-log";
import { DeliveryPolicy } from "../dispatch/policy";
import { RecipientResolver } from "../dispatch/recipients";
import { env } from "../env";
import { wallClock } from "../wall-clock";

/** An in-app message's data: the arguments of its copy. */
const messageData = z.record(z.string(), z.string());

// A few minutes past the hour, away from the top-of-the-hour rush.
const SCHEDULE = "5 * * * *";

@Injectable()
export class DigestService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly producer;

  constructor(
    @InjectI18n() private readonly i18n: I18n,
    @InjectDatabase() private readonly database: Database,
    @InjectRedis() redis: Redis,
    @InjectQueue("notifications-bulk") private readonly queue: QueueOf<"notifications-bulk">,
    private readonly recipients: RecipientResolver,
    private readonly log: DeliveryLog,
    private readonly policy: DeliveryPolicy,
    private readonly email: EmailChannel,
    @InjectPinoLogger(DigestService.name) private readonly logger: PinoLogger,
  ) {
    this.producer = createProducer("notifications-bulk", redis);
  }

  async onApplicationBootstrap() {
    await this.queue.upsertJobScheduler(
      "digests",
      { pattern: SCHEDULE, tz: "UTC" },
      { name: "digests", data: { meta: {}, payload: {} } },
    );
  }

  async onApplicationShutdown() {
    await this.producer.close();
  }

  /** Queues today's digest for every user with items whose digest time has come. */
  async scheduleDue(now = new Date()) {
    const withItems = await rows(
      z.object({ id: z.uuid() }),
      this.database.read.$queryRaw`SELECT notifications.users_with_digest_items() AS id`,
    );
    const users = await this.database.read.user.findMany({
      where: { id: { in: withItems.map((user) => user.id) } },
      select: { id: true, timezone: true },
    });
    const due = users.flatMap((user) => {
      const { hour, date } = wallClock(user.timezone, now);
      return hour >= env.DIGEST_HOUR ? [{ userId: userIdSchema.parse(user.id), date }] : [];
    });
    // Nothing due is an empty bulk add, which writes nothing.
    await this.producer.addBulk(
      due.map((digest) => ({
        name: "digest" as const,
        payload: digest,
        // Queued every hour until sent: the id keeps it to one job per user and day.
        options: { jobId: `digest-${digest.userId}-${digest.date}` },
      })),
    );
    return due.length;
  }

  /** Sends one user's digest for `date` (their local date), at most once. */
  async send(userId: UserId, date: string) {
    const key = `digest:${userId}:${date}`;
    if (!(await this.log.claim(key, "email", "digest", userId))) {
      return;
    }
    const [recipient] = await this.recipients.resolve({ userId });
    const scoped = withUser(this.database.write, userId);
    const items = await scoped.notificationDigestItem.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, template: true, data: true },
    });
    if (!recipient?.email || items.length === 0) {
      await this.log.finish(key, "skipped", { error: "nothing to send" });
      return;
    }
    const sent = { id: { in: items.map((item) => item.id) } };
    if (await this.policy.isSuppressed("email", recipient.email)) {
      await scoped.notificationDigestItem.deleteMany({ where: sent });
      await this.log.finish(key, "suppressed");
      return;
    }

    const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
    const lines = items.map((item) => {
      // Written from an in-app message's data (see the dispatcher): ICU arguments.
      const data = messageData.parse(item.data);
      const base = `notification.${item.template}`;
      return {
        title: loosely(t)(`${base}.title`, data),
        body: loosely(t)(`${base}.body`, data),
      };
    });
    const providerMessageId = await this.email.send(
      recipient.email,
      await renderEmail(DigestEmail, digestSubject, {
        locale: recipient.locale,
        t,
        items: lines,
        // Turning the digest off (or anything else) happens in notification settings.
        unsubscribeUrl: new URL("/settings/notifications", env.WEB_URL).toString(),
      }),
      key,
    );
    await scoped.notificationDigestItem.deleteMany({ where: sent });
    await this.log.finish(key, "sent", { providerMessageId });
    this.logger.info({ userId, items: items.length }, "digest sent");
  }
}
