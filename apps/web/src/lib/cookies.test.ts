import { afterEach, describe, expect, it, vi } from "vitest";
import { setPreferenceCookie } from "./cookies";

afterEach(() => vi.unstubAllGlobals());

describe("preference cookies", () => {
  it("are set site-wide for a year, the value encoded", () => {
    const document = { cookie: "" };
    vi.stubGlobal("document", document);
    setPreferenceCookie("tz", "America/Argentina/Buenos_Aires");
    expect(document.cookie).toBe(
      "tz=America%2FArgentina%2FBuenos_Aires; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });
});
