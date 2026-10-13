import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { NotificationsPage } from "@/modules/notifications";
import { currentUrl, renderPage } from "../render";
import { api, signUp } from "../users";
import { notify } from "./support";

describe("the inbox", () => {
  it("is empty for a new account", async () => {
    await signUp();
    const page = await renderPage(<NotificationsPage />, { url: "/notifications" });
    await expect.element(page.getByText("You're all caught up.")).toBeVisible();
    expect(page.getByRole("button", { name: "Mark all as read" }).query()).toBeNull();
  });

  it("opens a notification's link and marks it read", async () => {
    const user = await signUp();
    await notify(user.id, { title: "Pay the invoice ", link: "/settings/billing" });
    const page = await renderPage(<NotificationsPage />, { url: "/notifications" });
    await userEvent.click(page.getByRole("link", { name: /Pay the invoice 1/ }));
    await expect.poll(currentUrl).toBe("/settings/billing");
    await expect.poll(async () => (await api.notifications.unreadCount()).count).toBe(0);
  });

  it("stays here for one without a link, and doesn't mark a read one again", async () => {
    const user = await signUp();
    await notify(user.id, { title: "Old news ", link: null, read: true });
    const page = await renderPage(<NotificationsPage />, { url: "/notifications" });
    const item = page.getByRole("link", { name: /Old news 1/ });
    await expect.element(item).toHaveAttribute("href", "/notifications");
    expect(page.getByRole("button", { name: "Mark all as read" }).query()).toBeNull();
    await userEvent.click(item);
    expect(currentUrl()).toBe("/notifications");
  });

  it("marks everything read, and loads older ones page by page", async () => {
    const user = await signUp();
    await notify(user.id, { title: "Item ", count: 21 });
    const page = await renderPage(<NotificationsPage />, { url: "/notifications" });
    // Newest first: the oldest of 21 is on the second page.
    await expect.element(page.getByText("Item 21", { exact: true })).toBeVisible();
    expect(page.getByText("Item 1", { exact: true }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(page.getByText("Item 1", { exact: true })).toBeVisible();
    expect(page.getByRole("button", { name: "Load more" }).query()).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Mark all as read" }));
    await expect
      .element(page.getByRole("button", { name: "Mark all as read" }))
      .not.toBeInTheDocument();
    expect((await api.notifications.unreadCount()).count).toBe(0);
  });
});
