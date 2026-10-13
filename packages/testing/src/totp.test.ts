import { describe, expect, it } from "vitest";
import { totp } from "./totp";

describe("totp", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (base32 below), 6 digits.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("at %is is %s", (seconds, code) => {
    expect(totp(secret, seconds * 1000)).toBe(code);
  });

  it("ignores trailing bits that don't make a whole byte", () => {
    // "A" is 5 bits: no whole byte, so the same (empty) key as no secret at all.
    expect(totp("A", 0)).toBe(totp("", 0));
    expect(totp("gezdgnbvgy3tqojqgezdgnbvgy3tqojq===", 59_000)).toBe("287082");
  });
});
