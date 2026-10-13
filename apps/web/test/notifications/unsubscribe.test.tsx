import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { UnsubscribePage } from "@/modules/notifications";
import { renderPage } from "../render";
import { signOut, signUp } from "../users";

describe("the unsubscribe link", () => {
  it("turns that category's emails off, signed out", async () => {
    const user = await signUp();
    await signOut();
    const token = await commands.unsubscribeToken(user.id, "workspace");
    const page = await renderPage(<UnsubscribePage />, { url: `/unsubscribe?token=${token}` });
    await userEvent.click(page.getByRole("button", { name: "Unsubscribe" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Done. You won't get Workspace emails anymore.");
    expect(page.getByRole("button", { name: "Unsubscribe" }).query()).toBeNull();
    await expect
      .element(page.getByRole("link", { name: "Manage all notification settings" }))
      .toHaveAttribute("href", "/settings/notifications");
  });

  it("refuses a link that isn't ours", async () => {
    const page = await renderPage(<UnsubscribePage />, { url: "/unsubscribe?token=forged.token" });
    await userEvent.click(page.getByRole("button", { name: "Unsubscribe" }));
    await expect
      .element(page.getByText("This unsubscribe link isn't valid.", { exact: false }))
      .toHaveAttribute("role", "alert");
  });

  it("explains itself when opened without a link", async () => {
    const page = await renderPage(<UnsubscribePage />, { url: "/unsubscribe" });
    await expect
      .element(page.getByText("This page needs the link from one of our emails."))
      .toBeVisible();
  });
});
