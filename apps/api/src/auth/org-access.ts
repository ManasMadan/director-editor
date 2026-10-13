/**
 * What each organization role may do inside better-auth's organization and API key
 * plugins: the plugins' default permissions, plus managing the workspace's API keys for
 * owners and admins (the same people the `orgAdmin` procedures let through).
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

const apiKeyActions = ["create", "read", "update", "delete"] as const;

export const orgAccess = createAccessControl({ ...defaultStatements, apiKey: apiKeyActions });

export const orgRoles = {
  owner: orgAccess.newRole({ ...ownerAc.statements, apiKey: [...apiKeyActions] }),
  admin: orgAccess.newRole({ ...adminAc.statements, apiKey: [...apiKeyActions] }),
  member: orgAccess.newRole({ ...memberAc.statements }),
};
