import { describe, expect, it } from "vitest";
import { parseOrgRole } from "./roles";

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
});
