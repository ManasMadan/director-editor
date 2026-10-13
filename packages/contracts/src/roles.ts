/**
 * Workspace roles (better-auth organization roles), for the API's checks and every client.
 * better-auth stores a member's roles as one comma-joined string ("member,admin"), and a
 * database edit or a future role can put anything there. So roles are parsed, never
 * cast, and every check is an allow-list: a role this doesn't know grants nothing, and
 * can never pass as an admin.
 */
import * as z from "zod";

const ORG_ROLES = ["owner", "admin", "member"] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRoleSchema>;

const STRENGTH: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * The strongest role in better-auth's stored value, or null (not a member) when it's
 * empty or any part of it isn't a role this knows.
 */
export function parseOrgRole(stored: string | null | undefined): OrgRole | null {
  if (!stored) {
    return null;
  }
  const roles: OrgRole[] = [];
  for (const part of stored.split(",")) {
    const role = orgRoleSchema.safeParse(part.trim());
    if (!role.success) {
      return null;
    }
    roles.push(role.data);
  }
  return roles.reduce((strongest, role) =>
    STRENGTH[role] > STRENGTH[strongest] ? role : strongest,
  );
}

/** Owners and admins manage the workspace: settings, members, keys, the audit log. */
export function canManageWorkspace(role: OrgRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
