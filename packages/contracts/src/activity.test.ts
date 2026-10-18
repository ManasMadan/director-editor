import { describe, expect, it } from "vitest";
import { ACTIVITIES, activityName } from "./activity";

describe("activity names", () => {
  it("are each a domain and a fact, once", () => {
    for (const name of ACTIVITIES) {
      expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
    expect(new Set(ACTIVITIES).size).toBe(ACTIVITIES.length);
  });

  it("are the only names the schema takes", () => {
    expect(activityName.safeParse("auth.signed_in").success).toBe(true);
    expect(activityName.safeParse("auth.signed_in.v1").success).toBe(false);
  });
});
