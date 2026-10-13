import { describe, expect, it } from "vitest";
import { canManageWorkspace, parseOrgRole } from "./roles";

describe("workspace roles", () => {
  it.each([
    ["owner", "owner"],
    ["member", "member"],
    ["member,admin", "admin"],
    ["admin, owner", "owner"],
    ["owner,member", "owner"],
    ["viewer", null],
    ["member,viewer", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s reads as %s", (stored, role) => {
    expect(parseOrgRole(stored)).toBe(role);
  });

  it("let only owners and admins manage the workspace", () => {
    expect(canManageWorkspace("owner")).toBe(true);
    expect(canManageWorkspace("admin")).toBe(true);
    expect(canManageWorkspace("member")).toBe(false);
    expect(canManageWorkspace(null)).toBe(false);
  });
});
