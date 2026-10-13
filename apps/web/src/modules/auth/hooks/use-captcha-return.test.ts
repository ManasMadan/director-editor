import { describe, expect, it } from "vitest";
import { captchaReturnUrl } from "./use-captcha-return";

const ORIGIN = "https://site.example";

describe("captchaReturnUrl", () => {
  it.each([
    "boilerplate://captcha-done",
    "boilerplate://captcha-done?state=1",
    "https://site.example/captcha",
  ])("sends the token back to the app or this origin (%s)", (returnTo) => {
    expect(captchaReturnUrl(returnTo, ORIGIN)?.href).toBe(returnTo);
  });

  it.each([
    null,
    "",
    "not a url",
    "/captcha",
    "https://evil.example/captcha",
    "http://site.example/captcha",
    "https://site.example.evil.example/captcha",
    "//evil.example/captcha",
    "javascript:alert(1)",
    "otherapp://captcha",
  ])("refuses anywhere else (%s)", (returnTo) => {
    expect(captchaReturnUrl(returnTo, ORIGIN)).toBeNull();
  });
});
