import { describe, expect, it } from "vitest";
import { authErrorKey } from "./errors";
import { authFormSchemas } from "./forms";

describe("authErrorKey", () => {
  it.each([
    [{ code: "INVALID_EMAIL_OR_PASSWORD" }, "INVALID_EMAIL_OR_PASSWORD"],
    [{ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" }, "USER_ALREADY_EXISTS"],
    [{ code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" }, "PASSKEY_CANCELLED"],
    [{ status: 429 }, "RATE_LIMITED"],
    [{ status: 429, code: "INVALID_OTP" }, "RATE_LIMITED"],
    [{ error: "invalid_signature" }, "OAUTH_REQUEST_EXPIRED"],
    [{ code: "INVALID_OTP", error: "invalid_signature" }, "INVALID_OTP"],
  ])("%j → %s", (error, key) => {
    expect(authErrorKey(error)).toBe(key);
  });

  it.each([
    null,
    undefined,
    "boom",
    new Error("x"),
    {},
    // Codes with no sentence of their own, one that only looks like an alias included.
    { code: "SOMETHING_NEW" },
    { code: "toString" },
  ])("nothing to show for %j", (error) => {
    expect(authErrorKey(error)).toBeUndefined();
  });
});

describe("authFormSchemas", () => {
  const schemas = authFormSchemas((key, values) => `${key}${values ? JSON.stringify(values) : ""}`);

  it("carries the translated message of the rule that failed", () => {
    expect(schemas.email.safeParse("nope").error?.issues[0]?.message).toBe("email");
    expect(schemas.newPassword.safeParse("short").error?.issues[0]?.message).toMatch(
      /^passwordMin\{"min":\d+\}$/,
    );
    expect(schemas.password.safeParse("").error?.issues[0]?.message).toBe("required");
    expect(schemas.otp.safeParse("12").error?.issues[0]?.message).toBe("code");
  });

  it("accepts valid input", () => {
    expect(schemas.email.parse(" someone@example.com ")).toBe("someone@example.com");
    expect(schemas.otp.safeParse("123456").success).toBe(true);
  });
});
