import { describe, expect, it } from "vitest";
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

  it("takes the locale asked for, else the browser's, else English", () => {
    expect(newUserFields({ name: "A", locale: "en" }, null).locale).toBe("en");
    const browser = { path: "/sign-up/email", headers: headers({ "accept-language": "en-GB" }) };
    expect(newUserFields({ name: "A", locale: "" }, browser).locale).toBe("en");
    // A language the app doesn't have, asked for or from the browser.
    expect(newUserFields({ name: "A", locale: "es" }, null).locale).toBe("en");
    expect(
      newUserFields(
        { name: "A" },
        { headers: headers({ "x-locale": "es", "accept-language": "es-MX" }) },
      ).locale,
    ).toBe("en");
    expect(newUserFields({ name: "A" }, undefined).locale).toBe("en");
  });

  it("keeps a real time zone and replaces anything else with UTC", () => {
    expect(newUserFields({ name: "A", timezone: "Asia/Kolkata" }, null).timezone).toBe(
      "Asia/Kolkata",
    );
    expect(newUserFields({ name: "A", timezone: "Mars/Olympus" }, null).timezone).toBe("UTC");
  });
});
