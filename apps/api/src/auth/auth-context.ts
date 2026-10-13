/**
 * What every part of the auth configuration shares (auth.ts assembles it): the
 * dependencies, and the few helpers the hooks and plugins all use to audit changes and
 * pick an email's language.
 */
import type { Entitlements } from "@repo/contracts/billing";
import type { EventName, EventPayload } from "@repo/contracts/events";
import { type OrgId, type UserId, userIdSchema } from "@repo/contracts/ids";
import { type Db, transaction } from "@repo/db";
import { isLocale, type Locale, negotiateLocale } from "@repo/i18n";
import type { Producer } from "@repo/jobs";
import { currentContext } from "@repo/nest-common";
import type { BetterAuthOptions } from "better-auth";
import type { Redis } from "ioredis";
import type { Env } from "../env";
import { type EventOrigin, emitEvent } from "../outbox";
import { createAccountLimits, createEmailLimits } from "./account-limits";
import type { RemovedMember } from "./ids";
import type { Memberships } from "./memberships";

export interface AuthDependencies {
  env: Env;
  db: Db;
  redis: Redis;
  notifications: Pick<Producer<"notifications-critical">, "add">;
  memberships: Memberships;
  /** Plan limits and cancelling a deleted organization's subscription (modules/billing). */
  billing: {
    entitlements(orgId: OrgId): Promise<Entitlements>;
    cancelFor(orgId: OrgId): Promise<void>;
  };
  /** Where better-auth stores its rows; Postgres through Prisma unless given (auth.cli.ts). */
  database?: BetterAuthOptions["database"];
}

export interface AuthContext extends Omit<AuthDependencies, "database"> {
  accountLimits: ReturnType<typeof createAccountLimits>;
  emailLimits: ReturnType<typeof createEmailLimits>;
  /** Records an audit event for auth activity (see auth-events.ts for why it's separate). */
  record<N extends EventName>(
    name: N,
    key: string,
    payload: EventPayload<N>,
    origin: EventOrigin,
  ): Promise<unknown>;
  /** The signed-in user performing an auth action, when there is one. */
  actor(fallback: UserId): UserId;
  /**
   * A membership ended: removed by an admin, left, or gone with the account. The cached
   * role is forgotten so access ends on the next request, and the event audits it and
   * resyncs the plan's seats. better-auth runs afterRemoveMember only for removals, so
   * leaving (the after hook) and account deletion (afterDelete) call this too.
   */
  memberRemoved(member: RemovedMember, actorId: UserId): Promise<void>;
  /** Language for an email address: the account's saved locale, else the browser's. */
  localeFor(email: string, headers: Headers | undefined): Promise<Locale>;
  /** Shared workspaces an account being deleted belonged to, from beforeDelete to afterDelete. */
  leavingWithAccount: Map<UserId, RemovedMember[]>;
}

export function authContext(dependencies: Omit<AuthDependencies, "database">): AuthContext {
  const { db, redis, memberships } = dependencies;
  const record: AuthContext["record"] = (name, key, payload, origin) =>
    transaction(db, (tx) => emitEvent(tx, name, key, payload, origin));
  return {
    ...dependencies,
    accountLimits: createAccountLimits(redis),
    emailLimits: createEmailLimits(redis),
    record,
    // The request context holds the session's id as a plain string (it's logged).
    actor: (fallback) => userIdSchema.parse(currentContext()?.userId ?? fallback),
    async memberRemoved(member, actorId) {
      await memberships.forget(member.organizationId, member.userId);
      await record(
        "org.member_removed.v1",
        member.id,
        { organizationId: member.organizationId, userId: member.userId, role: member.role },
        { actorId, orgId: member.organizationId },
      );
    },
    async localeFor(email, headers) {
      const user = await db.user.findUnique({ where: { email }, select: { locale: true } });
      if (user && isLocale(user.locale)) {
        return user.locale;
      }
      return negotiateLocale(headers?.get("x-locale") ?? headers?.get("accept-language"));
    },
    leavingWithAccount: new Map(),
  };
}
