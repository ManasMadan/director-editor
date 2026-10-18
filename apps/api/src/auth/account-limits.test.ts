import { describe, expect, it } from "vitest";
import { ACCOUNT_LIMITS, accountKey } from "./account-limits";
import { DEMO_EMAIL } from "./demo";

const signIn = ACCOUNT_LIMITS["/sign-in/email"];
const totp = ACCOUNT_LIMITS["/two-factor/verify-totp"];

describe("the account a limited request is about", () => {
  it("is the normalised email, so case and spaces don't make new accounts", () => {
    if (!signIn) {
      throw new Error("sign-in is limited");
    }
    expect(
      accountKey(signIn, { path: "/sign-in/email", body: { email: " Ada@Example.com " } }),
    ).toBe("ada@example.com");
  });

  it("is the sign-in attempt's two-factor cookie for a second factor, hashed", () => {
    if (!totp) {
      throw new Error("TOTP is limited");
    }
    const key = accountKey(totp, {
      path: "/two-factor/verify-totp",
      secondFactor: "signed.cookie",
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("signed");
  });

  it("is missing for the demo account's sign-in while there is one, whose password is public then", () => {
    if (!signIn) {
      throw new Error("sign-in is limited");
    }
    const request = { path: "/sign-in/email", body: { email: ` ${DEMO_EMAIL.toUpperCase()}` } };
    expect(accountKey(signIn, request, DEMO_EMAIL)).toBeUndefined();
    // Without a demo account it's an address like any other.
    expect(accountKey(signIn, request)).toBe(DEMO_EMAIL);
  });

  it("is missing when the request names no account (it then fails validation)", () => {
    if (!signIn || !totp) {
      throw new Error("both are limited");
    }
    expect(accountKey(signIn, { path: "/sign-in/email", body: {} })).toBeUndefined();
    expect(accountKey(signIn, { path: "/sign-in/email", body: { email: "  " } })).toBeUndefined();
    expect(accountKey(signIn, { path: "/sign-in/email" })).toBeUndefined();
    expect(accountKey(totp, { path: "/two-factor/verify-totp" })).toBeUndefined();
  });
});
