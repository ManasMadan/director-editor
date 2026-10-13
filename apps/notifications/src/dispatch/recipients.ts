import { Injectable } from "@nestjs/common";
import { type UserId, userIdSchema } from "@repo/contracts/ids";
import { type Locale, localeOrDefault, timeZoneOrUtc } from "@repo/i18n";
import type { NotificationPayload } from "@repo/jobs";
import { type Database, InjectDatabase, rows } from "@repo/nest-common";
import * as z from "zod";

export interface Recipient {
  /** Null for an address without an account (an invitee, a number being verified). */
  userId: UserId | null;
  /** Null for a phone number being verified: text only. */
  email: string | null;
  /** A verified number to text, when the job names one. */
  phone: string | null;
  name: string | null;
  locale: Locale;
  timeZone: string;
}

const userRow = z.object({
  id: userIdSchema,
  email: z.string(),
  name: z.string(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
});
type UserRow = z.infer<typeof userRow>;

const toRecipient = (user: UserRow): Recipient => ({
  userId: user.id,
  email: user.email,
  phone: null,
  name: user.name,
  locale: localeOrDefault(user.locale),
  timeZone: timeZoneOrUtc(user.timezone),
});

/**
 * Turns a job's `to` into deliverable recipients. Identity (email, name, locale) and
 * organization roles are owned by the auth schema; this service only reads them.
 */
@Injectable()
export class RecipientResolver {
  constructor(@InjectDatabase() private readonly database: Database) {}

  async resolve(to: NotificationPayload["to"]): Promise<Recipient[]> {
    if ("email" in to) {
      const phone = ("phone" in to && to.phone) || null;
      return [
        { userId: null, email: to.email, phone, name: null, locale: to.locale, timeZone: "UTC" },
      ];
    }
    if ("phone" in to) {
      return [
        {
          userId: null,
          email: null,
          phone: to.phone,
          name: null,
          locale: to.locale,
          timeZone: "UTC",
        },
      ];
    }
    if ("userId" in to) {
      const user = await this.database.read.user.findUnique({
        where: { id: to.userId },
        select: { id: true, email: true, name: true, locale: true, timezone: true },
      });
      return user ? [toRecipient({ ...user, id: to.userId })] : [];
    }
    // Only these member columns are granted to this service (see the migration).
    const users = await rows(
      userRow,
      this.database.read.$queryRaw`
        SELECT u.id, u.email, u.name, u.locale, u.timezone
        FROM auth.member m JOIN auth."user" u ON u.id = m.user_id
        WHERE m.organization_id = ${to.orgId}::uuid AND m.role = ANY(${to.roles}::text[])`,
    );
    return users.map(toRecipient);
  }
}
