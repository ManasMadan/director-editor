import { describe, expect, it } from "vitest";
import { passkeyOrigins } from "./auth";
import { newUserFields } from "./auth-hooks";

const headers = (values: Record<string, string>) => new Headers(values);

describe("a new account's row", () => {
  it("keeps a picture only from a social provider's profile", () => {
    const user = { name: "Ada", image: "https://lh3.example/ada.png" };
    expect(newUserFields(user, { path: "/callback/google" }).image).toBe(user.image);
    expect(newUserFields({ name: "Ada" }, { path: "/sign-in/social" }).image).toBeNull();
    expect(newUserFields(user, { path: "/sign-up/email" }).image).toBeNull();
    expect(newUserFields(user, null).image).toBeNull();
  });

  it("trims the name and bounds its length", () => {
    expect(newUserFields({ name: `  ${"a".repeat(200)}  ` }, null).name).toHaveLength(100);
  });

  it("takes the locale asked for, else the browser's", () => {
    expect(newUserFields({ name: "A", locale: "es" }, null).locale).toBe("es");
    const browser = { path: "/sign-up/email", headers: headers({ "accept-language": "es-MX" }) };
    expect(newUserFields({ name: "A", locale: "" }, browser).locale).toBe("es");
    expect(
      newUserFields(
        { name: "A" },
        { headers: headers({ "x-locale": "es", "accept-language": "en" }) },
      ).locale,
    ).toBe("es");
    expect(newUserFields({ name: "A" }, undefined).locale).toBe("en");
  });

  it("keeps a real time zone and replaces anything else with UTC", () => {
    expect(newUserFields({ name: "A", timezone: "Asia/Kolkata" }, null).timezone).toBe(
      "Asia/Kolkata",
    );
    expect(newUserFields({ name: "A", timezone: "Mars/Olympus" }, null).timezone).toBe("UTC");
  });
});

describe("passkeys", () => {
  const site = {
    WEB_URL: "https://app.example.com",
    APP_ORIGINS: [],
    ANDROID_CERT_FINGERPRINTS: [],
  };

  it("come from the site, and from the Android app signed with each certificate", () => {
    // The certificate's SHA-256 as Credential Manager reports it: base64url, unpadded
    // (these 0xFF bytes would be "//…8=" in plain base64).
    const certificate = Array.from({ length: 32 }, () => "FF").join(":");
    expect(passkeyOrigins({ ...site, ANDROID_CERT_FINGERPRINTS: [certificate] })).toEqual([
      "https://app.example.com",
      `android:apk-key-hash:${"_".repeat(42)}8`,
    ]);
    expect(passkeyOrigins(site)).toEqual(["https://app.example.com"]);
  });

  it("come from the product's other origins too (the mobile app's web build)", () => {
    expect(passkeyOrigins({ ...site, APP_ORIGINS: ["http://localhost:3005"] })).toEqual([
      "https://app.example.com",
      "http://localhost:3005",
    ]);
  });
});
