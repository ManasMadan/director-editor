/**
 * better-auth's ids, as the rest of the API types them. better-auth hands every id over
 * as a plain string (users, sessions, members, organizations); these parse them into the
 * branded ids of @repo/contracts/ids once, where they leave better-auth, so a user's id
 * can't be passed on where a workspace's belongs.
 */
import { orgIdSchema, userIdSchema } from "@repo/contracts/ids";
import * as z from "zod";

/** A better-auth user's id. */
export const userIdOf = (user: { id: string }) => userIdSchema.parse(user.id);

/** A better-auth organization's id. */
export const orgIdOf = (organization: { id: string }) => orgIdSchema.parse(organization.id);

/** A membership better-auth hands to a hook: whose, and in which workspace. */
export const membershipOf = (member: { userId: string }, organization: { id: string }) => ({
  userId: userIdSchema.parse(member.userId),
  orgId: orgIdOf(organization),
});

/** A member who left a workspace (better-auth's member row, or ours). */
export const removedMemberSchema = z.object({
  id: z.string(),
  userId: userIdSchema,
  role: z.string(),
  organizationId: orgIdSchema,
});
export type RemovedMember = z.infer<typeof removedMemberSchema>;

/** A signed-in session as better-auth returns it, with the user's and workspace's ids branded. */
export function sessionWithIds<
  User extends { id: string },
  Session extends { userId: string; activeOrganizationId?: string | null | undefined },
>(result: { user: User; session: Session }) {
  return {
    user: { ...result.user, id: userIdOf(result.user) },
    session: {
      ...result.session,
      userId: userIdSchema.parse(result.session.userId),
      activeOrganizationId: orgIdSchema.nullish().parse(result.session.activeOrganizationId),
    },
  };
}
