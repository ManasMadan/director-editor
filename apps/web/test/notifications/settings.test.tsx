import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { NotificationSettingsPage } from "@/modules/notifications";
import { renderPage } from "../render";
import { api, signUp } from "../users";

const saved = (page: Awaited<ReturnType<typeof renderPage>>) =>
  expect.element(page.getByText("Notification settings saved").last()).toBeVisible();

describe("notification settings", () => {
  it("turns a category's channel and the daily digest off and on", async () => {
    await signUp();
    const page = await renderPage(<NotificationSettingsPage />, { url: "/settings/notifications" });
    const workspaceEmail = page
      .getByRole("group", { name: "Workspace" })
      .getByRole("checkbox", { name: "Email" });
    await expect.element(workspaceEmail).toBeChecked();
    await userEvent.click(workspaceEmail);
    await saved(page);
    await expect.element(workspaceEmail).not.toBeChecked();

    const digest = page.getByRole("checkbox", { name: "Daily digest" });
    await userEvent.click(digest);
    await expect.element(digest).toBeChecked();
    expect((await api.notifications.preferences()).dailyDigest).toBe(true);
  });

  it("sets quiet hours, and changes only what was changed", async () => {
    await signUp();
    const page = await renderPage(<NotificationSettingsPage />, { url: "/settings/notifications" });
    await userEvent.click(page.getByRole("checkbox", { name: "Pause push and texts at night" }));
    const from = page.getByLabelText("From");
    await expect.element(from).toHaveValue("22:00");
    await expect.element(page.getByLabelText("Until")).toHaveValue("07:00");

    // Tab moves between a time field's parts; clicking elsewhere leaves it.
    const leave = () => userEvent.click(page.getByText("Quiet hours", { exact: true }));
    // Left as it was, or cleared: nothing to save.
    await userEvent.click(from);
    await leave();
    await userEvent.clear(page.getByLabelText("Until"));
    await leave();

    await userEvent.fill(from, "23:30");
    await leave();
    await expect
      .poll(async () => (await api.notifications.preferences()).quietHours)
      .toEqual({ start: 23 * 60 + 30, end: 7 * 60 });

    await userEvent.click(page.getByRole("checkbox", { name: "Pause push and texts at night" }));
    await expect.element(from).not.toBeInTheDocument();
    expect((await api.notifications.preferences()).quietHours).toBeNull();
  });

  it("says when a change couldn't be saved", async () => {
    await signUp();
    const page = await renderPage(<NotificationSettingsPage />, { url: "/settings/notifications" });
    const digest = page.getByRole("checkbox", { name: "Daily digest" });
    await expect.element(digest).toBeVisible();
    await commands.failRequests("/rpc/notifications/updatePreferences");
    await userEvent.click(digest);
    await expect
      .element(page.getByText("We can't reach the server. Check your connection and try again."))
      .toBeVisible();
  });
});
