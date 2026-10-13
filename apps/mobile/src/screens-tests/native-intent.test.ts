// Tests live outside src/app: every file there is a route.
import { redirectSystemPath } from "../app/+native-intent";

describe("links the OS opens the app with", () => {
  it("opens the app's own links as they are", () => {
    const path = "boilerplate://invitations/abc";
    expect(redirectSystemPath({ path, initial: false })).toBe(path);
    expect(redirectSystemPath({ path, initial: true })).toBe(path);
  });

  it("leaves the security check's answer to the browser session waiting for it", () => {
    const path = "boilerplate://captcha-done?token=token-1";
    expect(redirectSystemPath({ path, initial: false })).toBeNull();
    // The app was closed meanwhile: it starts as usual.
    expect(redirectSystemPath({ path, initial: true })).toBe("/");
  });
});
