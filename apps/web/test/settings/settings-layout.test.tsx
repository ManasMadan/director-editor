import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { SettingsLayout } from "@/modules/settings";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { teamWorkspace } from "../workspace/support";

const tabs = (page: Awaited<ReturnType<typeof renderPage>>, nav: string) =>
  page
    .getByRole("navigation", { name: nav })
    .getByRole("link")
    .elements()
    .map((link) => link.textContent);

describe("the settings tabs", () => {
  it("offers owners every workspace tab, billing included, and marks the current one", async () => {
    await signUp();
    const page = await renderPage(
      <SettingsLayout>
        <p>profile form</p>
      </SettingsLayout>,
      { url: "/settings" },
    );
    await expect.element(page.getByText("profile form")).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Billing" })).toBeVisible();
    expect(tabs(page, "Your account")).toEqual(["Profile", "Security", "Notifications"]);
    expect(tabs(page, "Workspace")).toEqual([
      "General",
      "Members",
      "Webhooks",
      "API keys",
      "Audit log",
      "Billing",
    ]);
    await expect
      .element(page.getByRole("link", { name: "Profile" }))
      .toHaveAttribute("aria-current", "page");
    expect(
      page.getByRole("link", { name: "Security" }).element().getAttribute("aria-current"),
    ).toBeNull();

    await userEvent.click(page.getByRole("link", { name: "Members" }));
    await expect.poll(currentUrl).toBe("/settings/members");
  });

  it("marks a nested page's tab, and shows members only the tabs they can use", async () => {
    const user = await signUp();
    const workspace = await teamWorkspace();
    await commands.sql(
      "UPDATE auth.member SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [workspace.id, user.id],
    );
    const page = await renderPage(
      <SettingsLayout>
        <p>members list</p>
      </SettingsLayout>,
      { url: "/settings/members/invite" },
    );
    await expect
      .element(page.getByRole("link", { name: "Members" }))
      .toHaveAttribute("aria-current", "page");
    await expect.poll(() => tabs(page, "Workspace")).toEqual(["General", "Members"]);
  });
});
