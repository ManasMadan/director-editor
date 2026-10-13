import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { NotificationBell } from "@/modules/notifications";
import { currentUrl, renderPage } from "../render";
import { api, signUp } from "../users";
import { notify } from "./support";

describe("the notification bell", () => {
  it("has nothing to show for a new account, and leads to the inbox", async () => {
    await signUp();
    const page = await renderPage(<NotificationBell />, { url: "/dashboard" });
    await userEvent.click(page.getByRole("button", { name: "Notifications" }));
    await expect.element(page.getByText("You're all caught up.")).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Mark all as read" }).query()).toBeNull();
    await userEvent.click(page.getByRole("menuitem", { name: "See all notifications" }));
    await expect.poll(currentUrl).toBe("/notifications");
  });

  it("counts unread ones, and opens one where it points", async () => {
    const user = await signUp();
    await notify(user.id, { title: "Read ", link: null, read: true });
    await notify(user.id, { title: "Fresh ", link: "/settings" });
    const page = await renderPage(<NotificationBell />, { url: "/dashboard" });
    const bell = page.getByRole("button", { name: "1 unread notification" });
    await expect.element(bell).toHaveTextContent("1");

    // A read one without a link: nothing to do.
    await userEvent.click(bell);
    await userEvent.click(page.getByRole("menuitem", { name: /Read 1/ }));
    expect(currentUrl()).toBe("/dashboard");

    await userEvent.click(bell);
    await userEvent.click(page.getByRole("menuitem", { name: /Fresh 1/ }));
    await expect.poll(currentUrl).toBe("/settings");
    await expect.poll(async () => (await api.notifications.unreadCount()).count).toBe(0);
  });

  it("caps the badge at 99+, and marks everything read", async () => {
    const user = await signUp();
    await notify(user.id, { count: 100 });
    const page = await renderPage(<NotificationBell />, { url: "/dashboard" });
    const bell = page.getByRole("button", { name: "100 unread notifications" });
    await expect.element(bell).toHaveTextContent("99+");
    await userEvent.click(bell);
    await userEvent.click(page.getByRole("menuitem", { name: "Mark all as read" }));
    await expect.element(page.getByRole("button", { name: "Notifications" })).toBeVisible();
  });
});
