import { describe, expect, it } from "vitest";
import { authSessionKeys } from "./auth-settings";

describe("authSessionKeys", () => {
  it("names each session's key and the user's list of them, as better-auth keeps them", () => {
    expect(authSessionKeys("u-1", ["t-1", "t-2"])).toEqual([
      "auth:t-1",
      "auth:t-2",
      "auth:active-sessions-u-1",
    ]);
    expect(authSessionKeys("u-2", [])).toEqual(["auth:active-sessions-u-2"]);
  });
});
