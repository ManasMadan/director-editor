/** The configuration better-auth's CLI reads (`bun run auth:schema`). */
import { getSchema } from "better-auth/db";
import { describe, expect, it } from "vitest";
import { auth, inert } from "./auth.cli";

describe("the auth CLI's configuration", () => {
  // Verifications live in Redis (secondary storage), so they have no table.
  it("describes every table better-auth and its plugins use", () => {
    expect(Object.keys(getSchema(auth.options))).toEqual(
      expect.arrayContaining([
        "user",
        "session",
        "account",
        "organization",
        "member",
        "invitation",
        "twoFactor",
        "passkey",
      ]),
    );
  });

  it("sends nothing", async () => {
    await expect(inert.notifications.add("send", {} as never, { jobId: "x" })).rejects.toThrow(
      "The auth CLI never sends notifications",
    );
  });
});
