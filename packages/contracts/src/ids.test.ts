import { describe, expect, expectTypeOf, it } from "vitest";
import { type OrgId, orgIdSchema, type TodoId, type UserId, userIdSchema } from "./ids";

describe("branded ids", () => {
  // The type checker runs these: without the brands every id is a plain string and
  // each `.not` assertion fails to compile.
  it("keeps each kind of id apart, and plain strings out", () => {
    expectTypeOf<UserId>().not.toExtend<OrgId>();
    expectTypeOf<OrgId>().not.toExtend<UserId>();
    expectTypeOf<TodoId>().not.toExtend<OrgId>();
    expectTypeOf<string>().not.toExtend<OrgId>();
    // A branded id is still a string wherever one is expected.
    expectTypeOf<OrgId>().toExtend<string>();
  });

  it("parses a UUID into a branded id, unchanged", () => {
    const id = "0199a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b";
    expect(orgIdSchema.parse(id)).toBe(id);
    expectTypeOf(userIdSchema.parse(id)).toEqualTypeOf<UserId>();
  });

  it("refuses anything that isn't a UUID", () => {
    expect(orgIdSchema.safeParse("org-1").success).toBe(false);
  });
});
