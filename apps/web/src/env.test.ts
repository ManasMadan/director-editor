import { describe, expect, it } from "vitest";
import { envSchema } from "./env";

const fingerprint = (pair: string) => Array.from({ length: 32 }, () => pair).join(":");

describe("the web server's configuration", () => {
  it("reads the Android signing fingerprints as a list, upper-cased", () => {
    const value = ` ${fingerprint("ab")} , ${fingerprint("CD")}`;
    expect(envSchema.ANDROID_CERT_FINGERPRINTS.parse(value)).toEqual([
      fingerprint("AB"),
      fingerprint("CD"),
    ]);
    expect(envSchema.ANDROID_CERT_FINGERPRINTS.parse(undefined)).toBeUndefined();
  });

  it("refuses a fingerprint that isn't a SHA-256 one", () => {
    expect(() => envSchema.ANDROID_CERT_FINGERPRINTS.parse("AB:CD")).toThrow(
      "a SHA-256 fingerprint",
    );
  });
});
