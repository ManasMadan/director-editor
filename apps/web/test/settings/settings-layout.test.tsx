import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { SettingsLayout } from "@/modules/settings";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";

const tabs = (page: Awaited<ReturnType<typeof renderPage>>, nav: string) =>
  page
    .getByRole("navigation", { name: nav })
    .getByRole("link")
    .elements()
    .map((link) => link.textContent);

describe("the settings tabs", () => {
  it("offers the account's tabs, no workspace ones, and marks the current one", async () => {
    await signUp();
    const page = await renderPage(
      <SettingsLayout>
        <p>profile form</p>
      </SettingsLayout>,
      { url: "/settings" },
    );
    await expect.element(page.getByText("profile form")).toBeVisible();
    expect(tabs(page, "Your account")).toEqual(["Profile", "Security"]);
    expect(page.getByRole("navigation", { name: "Workspace" }).query()).toBeNull();
    await expect
      .element(page.getByRole("link", { name: "Profile" }))
      .toHaveAttribute("aria-current", "page");
    expect(
      page.getByRole("link", { name: "Security" }).element().getAttribute("aria-current"),
    ).toBeNull();

    await userEvent.click(page.getByRole("link", { name: "Security" }));
    await expect.poll(currentUrl).toBe("/settings/security");
  });

  it("marks a nested page's tab", async () => {
    await signUp();
    const page = await renderPage(
      <SettingsLayout>
        <p>sessions</p>
      </SettingsLayout>,
      { url: "/settings/security/sessions" },
    );
    await expect
      .element(page.getByRole("link", { name: "Security" }))
      .toHaveAttribute("aria-current", "page");
  });
});
