/**
 * The auth configuration's hooks (auth.ts): around every request (redirect and rate
 * checks before, security alerts after), on its database writes (normalised user rows,
 * the personal workspace, audit events), and on account deletion.
 */
import { NAME_MAX_LENGTH } from "@repo/contracts/auth";
import type { AuthErrorCode } from "@repo/contracts/errors";
import { type OrgId, orgIdSchema, type UserId, userIdSchema } from "@repo/contracts/ids";
import { fieldOf, required } from "@repo/contracts/objects";
import { parseOrgRole } from "@repo/contracts/roles";
import { transaction } from "@repo/db";
import { isLocale, isTimeZone, negotiateLocale } from "@repo/i18n";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { requestNotification } from "../notifications";
import { emitAnyEvent, emitEvent } from "../outbox";
import type { AuthContext } from "./auth-context";
import { auditEventForAlert, sessionEndReason, sessionMethod } from "./auth-events";
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

/** Where the mobile sign-in redirect (/expo-authorization-proxy) may send people. */
const PROVIDER_ORIGINS = new Set(["https://accounts.google.com"]);

/** A hook's request body and query: better-auth types them `any`; read them as unknown. */
const requestOf = (ctx: { body?: unknown; query?: unknown }) => ({
  body: ctx.body,
  query: ctx.query,
});

/**
 * The mobile app's sign-in goes through this redirect; left alone it sends anyone
 * anywhere over https from our own domain (phishing, planted OAuth state).
 */
function checkAuthorizationProxy(query: unknown) {
  const target = String(fieldOf(query, "authorizationURL") ?? "");
  if (!URL.canParse(target) || !PROVIDER_ORIGINS.has(new URL(target).origin)) {
    throw new APIError("BAD_REQUEST", {
      message: "Not a sign-in provider's address.",
      code: "INVALID_REDIRECT",
    });
  }
}

/**
 * The audit entry and the alert in one transaction: both or neither, and the alert leaves
 * through the outbox, so Redis being down delays it, never loses it.
 */
async function sendSecurityAlert(
  { db, env, localeFor }: AuthContext,
  alert: SecurityAlert,
  account: { id: string; phoneNumber: string | null },
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
        to: {
          email: alert.email,
          locale,
          ...(account.phoneNumber && { phone: account.phoneNumber }),
        },
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
  const { db, emailLimits, accountLimits, memberRemoved } = context;
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/expo-authorization-proxy") {
        checkAuthorizationProxy(requestOf(ctx).query);
      }
      // Invitation emails go out in the background, too late to refuse; so the limit is
      // taken here, for new invitations and resends alike.
      if (ctx.path === "/organization/invite-member") {
        const session = await getSessionFromCtx(ctx);
        const email = fieldOf(requestOf(ctx).body, "email");
        if (session && typeof email === "string") {
          await emailLimits.invitation(session.user.id, email);
        }
      }
      // Per account, on top of the per-address limits above (account-limits.ts).
      await accountLimits({
        path: ctx.path,
        body: requestOf(ctx).body,
        secondFactor: ctx.getCookie(ctx.context.createAuthCookie("two_factor").name) ?? undefined,
      });
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (isAPIError(ctx.context.returned)) {
        return;
      }
      // Hooks get no session; the member who left is the one returned.
      if (ctx.path === "/organization/leave") {
        const member = removedMemberSchema.parse(ctx.context.returned);
        await memberRemoved(member, member.userId);
        return;
      }
      const alert = securityAlertFor(ctx);
      if (!alert) {
        return;
      }
      // better-auth has committed the change by now: whatever fails here is logged, and
      // never turns a change that happened into an error for the user.
      try {
        // The change succeeded, so its account exists.
        const account = await db.user.findUniqueOrThrow({
          where: ctx.context.session ? { id: ctx.context.session.user.id } : { email: alert.email },
          select: { id: true, phoneNumber: true },
        });
        await sendSecurityAlert(context, alert, account, ctx.headers);
      } catch (error) {
        ctx.context.logger.error("security alert not recorded", error);
      }
    }),
  };
}

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;

/** New users get their personal workspace; profile edits follow the sign-up rules. */
function userHooks({ db, record }: AuthContext): DatabaseHooks["user"] {
  return {
    create: {
      before: async (user, ctx) => ({ data: newUserFields(user, ctx) }),
      // Every user gets a personal workspace, so tenant-scoped features work from the
      // first sign-in, for solo users and teams alike.
      after: async (user) => {
        const userId = userIdOf(user);
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

/** Sessions start in a workspace, and their start and end are audited. */
function sessionHooks({ db, record, actor }: AuthContext): DatabaseHooks["session"] {
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
      },
    },
  };
}

export function databaseHooks(context: AuthContext): DatabaseHooks {
  return { user: userHooks(context), session: sessionHooks(context) };
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
  const { db, billing, leavingWithAccount, memberRemoved } = context;
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
      // Nothing may keep charging for a workspace that's going away.
      for (const organizationId of soleMember) {
        await billing.cancelFor(organizationId);
      }
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
