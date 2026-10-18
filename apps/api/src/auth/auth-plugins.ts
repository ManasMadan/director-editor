/**
 * The better-auth plugins whose configuration is more than a line (auth.ts lists them
 * all): emailed codes, organizations and the captcha.
 */
import { randomUUID } from "node:crypto";
import {
  ORGANIZATION_LIMIT,
  OTP_EXPIRES_IN,
  OTP_LENGTH,
  WORKSPACE_MEMBER_LIMIT,
} from "@repo/contracts/auth";
import { MINUTE_S } from "@repo/contracts/time";
import { transaction } from "@repo/db";
import { jobMetaFromContext } from "@repo/nest-common";
import { APIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { type OrganizationOptions, organization } from "better-auth/plugins/organization";
import type { Env } from "../env";
import { features } from "../features";
import { copySeedTemplates } from "../modules/director/seeds.repository";
import { emitEvent } from "../outbox";
import { type AuthContext } from "./auth-context";
import { membershipOf, orgIdOf, userIdOf } from "./ids";
import { orgAccess, orgRoles } from "./org-access";

/** Refuses a client's attempt to mark a workspace as someone's personal one. */
function refusePersonal(org: { slug?: string; metadata?: Record<string, unknown> }) {
  if (org.slug?.startsWith("personal-") || (org.metadata && "personal" in org.metadata)) {
    throw new APIError("BAD_REQUEST", { code: "VALIDATION_FAILED" });
  }
}

/** Sign-in, verification and email-change codes, sent through the notification service. */
export function emailOtpPlugin({ emailLimits, notifications, localeFor }: AuthContext) {
  return emailOTP({
    otpLength: OTP_LENGTH,
    expiresIn: OTP_EXPIRES_IN,
    overrideDefaultEmailVerification: true,
    sendVerificationOnSignUp: true,
    // Only a hash is stored, so a database leak exposes no live codes.
    storeOTP: "hashed",
    // Changing the email needs a code from the current address and one from the new
    // address, so a hijacked session alone can't move the account elsewhere.
    changeEmail: { enabled: true, verifyCurrentEmail: true },
    sendVerificationOTP: async ({ email, otp, type }, ctx) => {
      // better-auth sends codes in the background and answers the same either way (so
      // nobody learns which addresses have accounts): past the limit the code is dropped,
      // and better-auth logs why.
      await emailLimits.code(email);
      await notifications.add(
        "send",
        {
          template: "auth.otp",
          to: { email, locale: await localeFor(email, ctx?.headers) },
          data: { otp, purpose: type, expiresInMinutes: Math.round(OTP_EXPIRES_IN / MINUTE_S) },
        },
        { jobId: randomUUID(), meta: jobMetaFromContext() },
      );
    },
  });
}

/** Membership changes, audited and forgetting the cached role. */
function membershipHooks({
  memberships,
  record,
  actor,
  memberRemoved,
}: AuthContext): NonNullable<OrganizationOptions["organizationHooks"]> {
  return {
    afterAddMember: async ({ member, organization: org }) => {
      const { orgId, userId } = membershipOf(member, org);
      await memberships.forget(orgId, userId);
      await record(
        "org.member_added.v1",
        member.id,
        { organizationId: orgId, userId, role: member.role },
        { actorId: actor(userId), orgId },
      );
    },
    afterRemoveMember: async ({ member, organization: org }) => {
      const { orgId, userId } = membershipOf(member, org);
      await memberRemoved(
        { id: member.id, userId, role: member.role, organizationId: orgId },
        actor(userId),
      );
    },
    afterUpdateMemberRole: async ({ member, previousRole, organization: org }) => {
      const { orgId, userId } = membershipOf(member, org);
      await memberships.forget(orgId, userId);
      await record(
        "org.member_role_changed.v1",
        member.id,
        { organizationId: orgId, userId, role: member.role, previousRole },
        { actorId: actor(userId), orgId },
      );
    },
  };
}

/** Workspaces created and deleted, audited; and nobody invited to one. */
function workspaceHooks({
  db,
  memberships,
  record,
}: AuthContext): NonNullable<OrganizationOptions["organizationHooks"]> {
  return {
    // Only the sign-up hook makes the personal workspace (slug personal-<user id>,
    // metadata.personal); a client claiming either could pass any workspace off as
    // someone's own, on the consent page too.
    beforeCreateOrganization: async ({ organization: org }) => refusePersonal(org),
    beforeUpdateOrganization: async ({ organization: org }) => refusePersonal(org),
    // A team's library starts with Director's seeded templates, like a personal one's.
    // better-auth has already written the workspace, so they're copied together with its
    // audit event: should that fail, the request errors for a workspace that exists, its
    // audit event is lost with the copy, and only the seeds come back (the backfill).
    afterCreateOrganization: async ({ organization: org, user }) => {
      const [orgId, userId] = [orgIdOf(org), userIdOf(user)];
      await memberships.forget(orgId, userId);
      await transaction(db, async (tx) => {
        await copySeedTemplates(tx, orgId);
        await emitEvent(
          tx,
          "org.created.v1",
          orgId,
          { organizationId: orgId, name: org.name },
          { actorId: userId, orgId },
        );
      });
    },
    beforeDeleteOrganization: async ({ organization: org }) => {
      // A personal workspace goes only with its account (account deletion removes it):
      // without one, its owner would be left with nowhere to work, and the shared demo
      // account's would take every judge's takes with it.
      if (org.slug.startsWith("personal-")) {
        throw new APIError("FORBIDDEN", {
          code: "FORBIDDEN",
          message: "A personal workspace is deleted with its account.",
        });
      }
      await memberships.forgetOrganization(orgIdOf(org));
    },
    // A workspace holds its owner alone (WORKSPACE_MEMBER_LIMIT is 1, and the inviter is
    // a member), so every invitation is refused before better-auth writes it. better-auth
    // checks the member limit only when one is accepted, which would leave invitations
    // waiting that nobody can use. Raising the limit means counting members and pending
    // invitations against it here.
    beforeCreateInvitation: async () => {
      throw new APIError("FORBIDDEN", {
        code: "FORBIDDEN",
        message: "The workspace's member limit is reached.",
      });
    },
    afterDeleteOrganization: async ({ organization: org, user }) => {
      const orgId = orgIdOf(org);
      await record(
        "org.deleted.v1",
        orgId,
        { organizationId: orgId },
        { actorId: userIdOf(user), orgId },
      );
    },
  };
}

export function organizationPlugin(context: AuthContext) {
  return organization({
    creatorRole: "owner",
    ac: orgAccess,
    roles: orgRoles,
    organizationLimit: ORGANIZATION_LIMIT,
    membershipLimit: WORKSPACE_MEMBER_LIMIT,
    // Every membership change is audited (in the organization's own log, so its admins
    // see it) and forgets the cached role, so access follows immediately.
    organizationHooks: { ...workspaceHooks(context), ...membershipHooks(context) },
  });
}

/** Turnstile on the forms that create accounts or send codes, when it's configured. */
export function captchaPlugins(env: Env) {
  if (!features.captcha || !env.TURNSTILE_SECRET_KEY) {
    return [];
  }
  return [
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: env.TURNSTILE_SECRET_KEY,
      endpoints: [
        "/sign-up/email",
        "/email-otp/send-verification-otp",
        "/email-otp/request-password-reset",
      ],
    }),
  ];
}
