import { describe, expect, it } from "vitest";
import { isWebPushEndpoint } from "./notifications";

describe("isWebPushEndpoint", () => {
  it("accepts the browsers' push services", () => {
    expect(isWebPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isWebPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isWebPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isWebPushEndpoint("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true);
  });

  it("rejects anything that could point the service elsewhere", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user@fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.dev/x",
      "https://evilnotify.windows.com.attacker.dev/x",
      "https://notify.windows.com/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/x",
      "not a url",
    ]) {
      expect(isWebPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it("accepts extra hosts when given (local test servers)", () => {
    expect(isWebPushEndpoint("https://push.test/x", ["push.test"])).toBe(true);
  });
});
