/** The security check the mobile app opens (this project's API has captcha on). */
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { CaptchaPage } from "@/modules/auth";
import { renderPage } from "../render";

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const open = (returnTo: string) =>
  renderPage(<CaptchaPage />, { url: `/captcha?${new URLSearchParams({ return_to: returnTo })}` });

describe("the captcha page", () => {
  it("sends the token back to the app once the check passes", async () => {
    const page = await open("boilerplate://captcha-done");
    await expect.element(page.getByTestId("captcha")).toHaveAttribute("data-widget");
    await expect
      .element(page.getByRole("link", { name: "Back to the app" }))
      .toHaveAttribute("href", `boilerplate://captcha-done?token=${TOKEN}`);
  });

  it("goes back to the app's web build on this origin by itself", async () => {
    const back = `${window.location.origin}/captcha?state=1`;
    await open(back);
    await expect.poll(commands.hardNavigations).toEqual([`${back}&token=${TOKEN}`]);
  });

  it.each(["https://evil.example/captcha", "//evil.example/captcha", "javascript:alert(1)", ""])(
    "refuses to send the token anywhere else (%s)",
    async (returnTo) => {
      const page = await open(returnTo);
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("This page works only when the app opens it.");
      expect(page.getByTestId("captcha").query()).toBeNull();
      expect(await commands.hardNavigations()).toEqual([]);
    },
  );
});
