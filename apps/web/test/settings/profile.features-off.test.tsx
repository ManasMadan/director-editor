/** The profile page on a deployment without uploads, with captcha on. */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { ProfileSettingsPage } from "@/modules/settings";
import { renderPage } from "../render";
import { signUp, takeOtp } from "../users";

describe("the profile page with uploads off and captcha on", () => {
  it("has no picture section, and asks for the security check before emailing a code", async () => {
    const user = await signUp();
    const page = await renderPage(<ProfileSettingsPage />, { url: "/settings" });
    await expect.element(page.getByText(user.email, { exact: true })).toBeVisible();
    // The picture card keeps its room only until the page knows uploads are off.
    await expect.element(page.getByText("Profile picture")).not.toBeInTheDocument();

    await expect.element(page.getByTestId("captcha")).toHaveAttribute("data-widget");
    await userEvent.click(page.getByRole("button", { name: "Change email" }));
    await expect.element(page.getByLabelText(`Code sent to ${user.email}`)).toBeVisible();
    expect(await takeOtp(user.email)).toMatch(/^\d{6}$/);
  });
});
