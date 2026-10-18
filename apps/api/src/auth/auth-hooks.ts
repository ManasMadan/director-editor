/**
 * The auth configuration's hooks (auth.ts): around every request (redirect and rate
 * checks before, security alerts after), on its database writes (normalised user rows,
 * the personal workspace, audit events), and on account deletion.
 */
import { allowsUploads } from "@repo/contracts/api";
import { NAME_MAX_LENGTH } from "@repo/contracts/auth";
import type { AuthErrorCode } from "@repo/contracts/errors";
import { type OrgId, orgIdSchema, type UserId, userIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { parseOrgRole } from "@repo/contracts/roles";
import { transaction } from "@repo/db";
import { isLocale, isTimeZone, negotiateLocale } from "@repo/i18n";
import { updateContext } from "@repo/nest-common";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { actorContext } from "../http-context";
import { copySeedTemplates } from "../modules/director/seeds.repository";
import { requestNotification } from "../notifications";
import { emitAnyEvent, emitEvent } from "../outbox";
import { googleLinked, sessionEnded, signInMethod, youtubeGranted } from "./auth-activity";
import type { AuthContext } from "./auth-context";
import { auditEventForAlert, sessionEndReason, sessionMethod } from "./auth-events";
import { DEMO_LOCKED_PATHS, ownSessionOnly, refuseDemoProfileChange, refuseForDemo } from "./demo";
import { orgIdOf, removedMemberSchema, userIdOf } from "./ids";
import { type SecurityAlert, securityAlertFor } from "./security-alerts";

/** The paths that create an account from a social provider's profile (Google's). */
const SOCIAL_SIGN_UP = /^\/(callback\/|sign-in\/social$)/;

/**
 * A new account's row, its client-supplied preferences normalised instead of trusted.
 * Without an explicit locale, the browser's language decides (so the verification email
 * sent right after sign-up is already in the right language).
 */
export function newUserFields<
  T extends {
    name: unknown;
    image?: string | null | undefined;
    locale?: unknown;
    timezone?: unknown;
  },
>(user: T, ctx: { path?: string; headers?: Headers | undefined } | null | undefined) {
  return {
    ...user,
    // A picture comes only from a social provider's profile at sign-up; sign-up's body
    // would take any string, and the avatar flow owns it after that.
    image: SOCIAL_SIGN_UP.test(ctx?.path ?? "") ? (user.image ?? null) : null,
    name: String(user.name).trim().slice(0, NAME_MAX_LENGTH),
    locale: negotiateLocale(
      typeof user.locale === "string" && user.locale
        ? user.locale
        : (ctx?.headers?.get("x-locale") ?? ctx?.headers?.get("accept-language")),
    ),
    timezone: isTimeZone(user.timezone) ? user.timezone : "UTC",
  };
}

/** A hook's request body: better-auth types it `any`; read it as unknown. */
const requestOf = (ctx: { body?: unknown }) => ({ body: ctx.body });

/**
 * The audit entry and the alert in one transaction: both or neither, and the alert leaves
 * through the outbox, so Redis being down delays it, never loses it.
 */
async function sendSecurityAlert(
  { db, env, localeFor }: AuthContext,
  alert: SecurityAlert,
  account: { id: string },
  headers: Headers | undefined,
) {
  const userId = userIdOf(account);
  const locale = await localeFor(alert.email, headers);
  await transaction(db, async (tx) => {
    await emitAnyEvent(tx, auditEventForAlert(alert, userId), userId, {
      actorId: userId,
      orgId: null,
    });
    await requestNotification(
      tx,
      userId,
      {
        template: "auth.security-alert",
        to: { email: alert.email, locale },
        data: {
          event: alert.event,
          ...("newEmail" in alert && alert.newEmail && { newEmail: alert.newEmail }),
          securityUrl: new URL("/settings/security", env.WEB_URL).toString(),
        },
      },
      { actorId: userId, orgId: null },
    );
  });
}

/**
 * Security alerts: every sensitive change is emailed to the account's address, so a
 * takeover (or a mistake) never goes unnoticed. Runs after the endpoint, only when it
 * succeeded, and never fails the request: the email is queued with retries.
 */
export function requestHooks(context: AuthContext) {
  const { db, accountLimits, memberRemoved } = context;
  return {
    before: createAuthMiddleware(async (ctx) => {
      // Everyone trying Director shares the demo account: nobody may change or lock it.
      if (DEMO_LOCKED_PATHS.has(ctx.path)) {
        refuseForDemo((await getSessionFromCtx(ctx))?.user);
      }
      // Per account, on top of the per-address limits above (account-limits.ts).
      await accountLimits({
        path: ctx.path,
        body: requestOf(ctx).body,
        secondFactor: ctx.getCookie(ctx.context.createAuthCookie("two_factor").name) ?? undefined,
      });
    }),
    // Each way out returns: the device list's answer may be replaced, nothing else's.
    after: createAuthMiddleware(async (ctx) => {
      if (isAPIError(ctx.context.returned)) {
        return undefined;
      }
      // The demo account's devices are other people's: it sees only its own.
      if (ctx.path === "/list-sessions") {
        const own = ownSessionOnly(ctx.context.returned, ctx.context.session);
        return own ? ctx.json(own) : undefined;
      }
      // Hooks get no session; the member who left is the one returned.
      if (ctx.path === "/organization/leave") {
        const member = removedMemberSchema.parse(ctx.context.returned);
        await memberRemoved(member, member.userId);
        return undefined;
      }
      const alert = securityAlertFor(ctx);
      if (!alert) {
        return undefined;
      }
      // better-auth has committed the change by now: whatever fails here is logged, and
      // never turns a change that happened into an error for the user.
      try {
        // The change succeeded, so its account exists.
        const account = await db.user.findUniqueOrThrow({
          where: ctx.context.session ? { id: ctx.context.session.user.id } : { email: alert.email },
          select: { id: true },
        });
        await sendSecurityAlert(context, alert, account, ctx.headers);
      } catch (error) {
        ctx.context.logger.error("security alert not recorded", error);
      }
      return undefined;
    }),
  };
}

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;

/** New users get their personal workspace; profile edits follow the sign-up rules. */
function userHooks({ db, record, activity }: AuthContext): DatabaseHooks["user"] {
  return {
    create: {
      before: async (user, ctx) => ({ data: newUserFields(user, ctx) }),
      // Every user gets a personal workspace, so tenant-scoped features work from the
      // first sign-in, for solo users and teams alike. Its library starts with Director's
      // seeded templates, in the same transaction: no workspace exists without them.
      after: async (user, ctx) => {
        const userId = userIdOf(user);
        // The rest of the request (the account linked, the session started) is theirs.
        updateContext(actorContext(user));
        activity({
          activity: "auth.signed_up",
          actor: actorContext(user),
          target: { method: signInMethod(ctx?.path, user.demo === true) },
        });
        await transaction(db, async (tx) => {
          const org = await tx.organization.create({
            data: {
              name: user.name,
              slug: `personal-${userId}`,
              metadata: JSON.stringify({ personal: true }),
              members: { create: { userId, role: "owner" } },
            },
          });
          const orgId = orgIdOf(org);
          await copySeedTemplates(tx, orgId);
          const origin = { actorId: userId, orgId };
          await emitEvent(tx, "auth.signed_up.v1", userId, { userId }, origin);
          await emitEvent(
            tx,
            "org.created.v1",
            orgId,
            { organizationId: orgId, name: org.name },
            origin,
          );
        });
      },
    },
    delete: {
      after: async (user) => {
        const userId = userIdOf(user);
        await record(
          "auth.account_deleted.v1",
          userId,
          { userId },
          { actorId: userId, orgId: null },
        );
      },
    },
    // Profile edits go through the same rules: an unknown language or zone is refused
    // rather than stored, so emails and dates never render with garbage settings.
    update: {
      before: async (user, ctx) => {
        // The picture is set only by the avatar flow (a checked upload), never to a URL a
        // client picks.
        if (ctx?.path === "/update-user" && user.image !== undefined) {
          throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
        }
        // Everyone shares the demo account: its name stays the one the command gives it.
        if (ctx?.path === "/update-user") {
          refuseDemoProfileChange(user, ctx.context.session?.user);
        }
        if (
          (user.locale !== undefined && !isLocale(user.locale)) ||
          (user.timezone !== undefined && !isTimeZone(user.timezone))
        ) {
          // Returning false would skip the write but still report success.
          throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
        }
        return {
          data: {
            ...user,
            ...(typeof user.name === "string" && {
              name: user.name.trim().slice(0, NAME_MAX_LENGTH),
            }),
          },
        };
      },
    },
  };
}

/** Who a new session is for, from here on in the request too (the activity lines). */
async function signedIn(db: AuthContext["db"], userId: UserId) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, demo: true },
  });
  const signedInActor = actorContext(user);
  updateContext(signedInActor);
  return signedInActor;
}

/** Sessions start in a workspace, and their start and end are audited and logged. */
function sessionHooks({ db, record, actor, activity }: AuthContext): DatabaseHooks["session"] {
  return {
    create: {
      // New sessions start in the user's first workspace (their personal one).
      before: async (session) => {
        if (session.activeOrganizationId) {
          return { data: session };
        }
        const membership = await db.member.findFirst({
          where: { userId: session.userId },
          orderBy: { createdAt: "asc" },
          select: { organizationId: true },
        });
        return {
          data: { ...session, activeOrganizationId: membership?.organizationId ?? null },
        };
      },
      after: async (session, ctx) => {
        const userId = userIdSchema.parse(session.userId);
        await record(
          "auth.session_started.v1",
          session.id,
          { userId, sessionId: session.id, method: sessionMethod(ctx?.path) },
          { actorId: userId, orgId: null },
        );
        const user = await signedIn(db, userId);
        activity({
          activity: "auth.signed_in",
          actor: user,
          target: { method: signInMethod(ctx?.path, user.demo) },
        });
      },
    },
    delete: {
      after: async (session, ctx) => {
        const userId = userIdSchema.parse(session.userId);
        await record(
          "auth.session_ended.v1",
          session.id,
          { userId, sessionId: session.id, reason: sessionEndReason(ctx?.path) },
          { actorId: actor(userId), orgId: null },
        );
        activity(sessionEnded(ctx?.path, userId));
      },
    },
  };
}

/**
 * Google accounts linked, at sign-up or later, and allowed to upload to YouTube: better-auth
 * writes an account's scopes only when someone links it again with more (linkSocial, as
 * the first publish asks), so an update carrying the upload scope is that grant. The
 * request it happens in is remembered from before the write to after it.
 */
function accountHooks({ activity }: AuthContext): DatabaseHooks["account"] {
  const granting = new WeakSet<object>();
  return {
    create: {
      after: async (account) => {
        for (const line of googleLinked(account)) {
          activity({ ...line, actor: { userId: account.userId } });
        }
      },
    },
    update: {
      before: async (account, ctx) => {
        if (ctx && allowsUploads(account.scope)) {
          granting.add(ctx);
        }
      },
      after: async (account, ctx) => {
        if (ctx && granting.delete(ctx)) {
          activity({ ...youtubeGranted, actor: { userId: account.userId } });
        }
      },
    },
  };
}

export function databaseHooks(context: AuthContext): DatabaseHooks {
  return {
    user: userHooks(context),
    session: sessionHooks(context),
    account: accountHooks(context),
  };
}

/**
 * The workspaces an account owns that it alone belongs to; throws when a shared one would
 * be left without an owner.
 */
async function soleWorkspaces({ db }: AuthContext, userId: UserId) {
  const owned = await db.member.findMany({
    where: { userId, role: "owner" },
    select: {
      organizationId: true,
      organization: { select: { members: { select: { userId: true, role: true } } } },
    },
  });
  const soleMember: OrgId[] = [];
  for (const { organizationId, organization } of owned) {
    const others = organization.members.filter((member) => member.userId !== userId);
    if (others.length === 0) {
      soleMember.push(orgIdSchema.parse(organizationId));
    } else if (!others.some((member) => parseOrgRole(member.role) === "owner")) {
      throw new APIError("BAD_REQUEST", {
        code: "ORGANIZATION_NEEDS_OWNER" satisfies AuthErrorCode,
        message: "Transfer ownership of your shared workspaces before deleting your account.",
      });
    }
  }
  return soleMember;
}

type DeleteUser = NonNullable<NonNullable<BetterAuthOptions["user"]>["deleteUser"]>;

/**
 * Workspaces only this user belongs to are deleted with the account, and their data with
 * them (tenant tables cascade from auth.organization). A shared workspace would be left
 * without an owner, so that blocks deletion until ownership is handed over.
 */
export function accountDeletion(context: AuthContext): DeleteUser {
  const { db, leavingWithAccount, memberRemoved } = context;
  return {
    enabled: true,
    beforeDelete: async (user) => {
      const userId = userIdOf(user);
      const soleMember = await soleWorkspaces(context, userId);
      const shared = await db.member.findMany({
        where: { userId, organizationId: { notIn: soleMember } },
        select: { id: true, userId: true, role: true, organizationId: true },
      });
      leavingWithAccount.set(userId, removedMemberSchema.array().parse(shared));
      await transaction(db, async (tx) => {
        await tx.organization.deleteMany({ where: { id: { in: soleMember } } });
        for (const organizationId of soleMember) {
          await emitEvent(
            tx,
            "org.deleted.v1",
            organizationId,
            { organizationId },
            { actorId: userId, orgId: organizationId },
          );
        }
      });
    },
    // The memberships went with the account (the rows cascade), past the organization
    // hooks: end them the same way a removal does.
    afterDelete: async (user) => {
      const userId = userIdOf(user);
      // beforeDelete ran first, in the same request.
      const left = required(leavingWithAccount.get(userId), "the memberships the account left");
      leavingWithAccount.delete(userId);
      for (const member of left) {
        await memberRemoved(member, userId);
      }
    },
  };
}
