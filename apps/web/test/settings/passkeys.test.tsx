import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { authClient } from "@/lib/auth-client";
import { PasskeysCard } from "@/modules/settings/components/passkeys-card";
import { renderPage } from "../render";
import { signUp } from "../users";

const CANCELLED =
  "The passkey prompt was closed before finishing. Try again, or use your password.";

describe("passkeys", () => {
  it("adds one with the device's authenticator, and removes it", async () => {
    await commands.virtualAuthenticator();
    await signUp();
    const page = await renderPage(<PasskeysCard />, { url: "/settings/security" });
    await expect.element(page.getByText("No passkeys yet.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add a passkey" }));
    await expect.element(page.getByText("Passkey added")).toBeVisible();
    // Unnamed, with the day it was added.
    // In the page's zone (renderPage's default, UTC), not the machine's: they differ
    // around midnight.
    const today = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(),
    );
    await expect.element(page.getByText(today)).toBeVisible();
    expect(page.getByText(today).element().parentElement?.textContent).toBe(`Passkey${today}`);
    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    await expect.element(page.getByText("No passkeys yet.")).toBeVisible();
  });

  it("shows a passkey's name, and no date when none was recorded", async () => {
    await commands.virtualAuthenticator();
    const user = await signUp();
    expect((await authClient.passkey.addPasskey({ name: "Work laptop" })).error).toBeFalsy();
    await commands.sql("UPDATE auth.passkey SET created_at = NULL WHERE user_id = $1", [user.id]);
    const page = await renderPage(<PasskeysCard />, { url: "/settings/security" });
    await expect.element(page.getByText("Work laptop", { exact: true })).toBeVisible();
  });

  it("says so when the prompt is dismissed, and adds nothing", async () => {
    await commands.virtualAuthenticator({ verified: false });
    await signUp();
    const page = await renderPage(<PasskeysCard />, { url: "/settings/security" });
    await expect.element(page.getByText("No passkeys yet.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add a passkey" }));
    await expect.element(page.getByText(CANCELLED)).toBeVisible();
    await expect.element(page.getByText("No passkeys yet.")).toBeVisible();
  });

  it("asks for a new sign-in before adding one to an old session", async () => {
    await commands.virtualAuthenticator();
    await signUp();
    await commands.ageSession();
    const page = await renderPage(<PasskeysCard />, { url: "/settings/security" });
    await userEvent.click(page.getByRole("button", { name: "Add a passkey" }));
    await expect.element(page.getByText("Confirm it's you")).toBeVisible();
  });

  it("says so when one can't be removed", async () => {
    await commands.virtualAuthenticator();
    const user = await signUp();
    expect((await authClient.passkey.addPasskey()).error).toBeFalsy();
    const page = await renderPage(<PasskeysCard />, { url: "/settings/security" });
    const remove = page.getByRole("button", { name: "Remove" });
    await expect.element(remove).toBeVisible();
    // Removed on another device meanwhile.
    await commands.sql("DELETE FROM auth.passkey WHERE user_id = $1", [user.id]);
    await userEvent.click(remove);
    await expect.element(page.getByText("No passkeys yet.")).toBeVisible();
    await expect
      .element(page.getByText(/passkey isn't registered|Something went wrong/))
      .toBeVisible();
  });
});
