/**
 * Who belongs to which organization, and with what role, as checked on every
 * organization-scoped request.
 *
 * A session only remembers which organization is active; membership can change under it
 * (removed, role changed, organization deleted), so every request re-checks. The answer
 * is cached in Redis for a few minutes, and every membership change in the auth config
 * forgets it immediately (the organization hooks, and `memberRemoved` for leaving and
 * account deletion, which better-auth's hooks miss), so a removed member loses access
 * on their very next request.
 */
import { type OrgId, type UserId, userIdSchema } from "@repo/contracts/ids";
import { type OrgRole, orgRoleSchema, parseOrgRole } from "@repo/contracts/roles";
import type { Db } from "@repo/db";
import { CacheService, type Redis } from "@repo/nest-common";

const TTL_SECONDS = 300;

export function createMemberships(db: Db, redis: Redis) {
  const cache = new CacheService(redis, "membership");
  const key = (orgId: OrgId, userId: UserId) => `${orgId}:${userId}`;

  return {
    /**
     * The user's role in the organization, or null when they aren't a member or their
     * stored role isn't one this knows (see @repo/contracts/roles: it fails closed).
     */
    role(orgId: OrgId, userId: UserId): Promise<OrgRole | null> {
      return cache.wrap(key(orgId, userId), TTL_SECONDS, orgRoleSchema.nullable(), async () => {
        const member = await db.member.findFirst({
          where: { organizationId: orgId, userId },
          select: { role: true },
        });
        return parseOrgRole(member?.role);
      });
    },
    /** Call after any change to this membership. */
    forget(orgId: OrgId, userId: UserId) {
      return cache.invalidate(key(orgId, userId));
    },
    /** Call before deleting an organization: forgets every member's cached role. */
    async forgetOrganization(orgId: OrgId) {
      const members = await db.member.findMany({
        where: { organizationId: orgId },
        select: { userId: true },
      });
      await Promise.all(
        members.map((member) => cache.invalidate(key(orgId, userIdSchema.parse(member.userId)))),
      );
    },
  };
}

export type Memberships = ReturnType<typeof createMemberships>;
