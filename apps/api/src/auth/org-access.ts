/**
 * What each organization role may do inside better-auth's organization plugin: its
 * default permissions.
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const orgAccess = createAccessControl({ ...defaultStatements });

export const orgRoles = {
  owner: orgAccess.newRole({ ...ownerAc.statements }),
  admin: orgAccess.newRole({ ...adminAc.statements }),
  member: orgAccess.newRole({ ...memberAc.statements }),
};
