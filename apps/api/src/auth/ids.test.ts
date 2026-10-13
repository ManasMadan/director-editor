import { randomUUID } from "node:crypto";
import type { OrgId, UserId } from "@repo/contracts/ids";
import { describe, expect, expectTypeOf, it } from "vitest";
import { membershipOf, sessionWithIds } from "./ids";

describe("better-auth's ids", () => {
  // Typed as better-auth types them: plain strings.
  const userId: string = randomUUID();
  const orgId: string = randomUUID();

  it("brands a session's user and workspace, keeping everything else", () => {
    const session: { id: string; userId: string; activeOrganizationId: string | null } = {
      id: "s1",
      userId,
      activeOrganizationId: orgId,
    };
    const branded = sessionWithIds({ user: { id: userId, name: "Ada" }, session });
    expect(branded).toEqual({
      user: { id: userId, name: "Ada" },
      session: { id: "s1", userId, activeOrganizationId: orgId },
    });
    expectTypeOf(branded.user.id).toEqualTypeOf<UserId>();
    expectTypeOf(branded.session.activeOrganizationId).toEqualTypeOf<OrgId | null>();
  });

  it("keeps a session without an active workspace without one", () => {
    const session = { id: "s1", userId, activeOrganizationId: null };
    expect(sessionWithIds({ user: { id: userId }, session }).session).toEqual(session);
  });

  it("refuses an id that isn't a UUID instead of passing it on", () => {
    const workspace = { id: randomUUID() };
    expect(membershipOf({ userId }, workspace)).toEqual({ userId, orgId: workspace.id });
    expect(() => membershipOf({ userId: "user-1" }, workspace)).toThrow();
  });
});
