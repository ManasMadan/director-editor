import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { authClient } from "@/lib/auth-client";
import { SiteHeader } from "@/modules/shell";
import { currentUrl, renderPage } from "../render";
import { signIn, signUp } from "../users";

describe("the site header", () => {
  it("offers sign in to visitors", async () => {
    const page = await renderPage(<SiteHeader />, { url: "/" });
    await expect.element(page.getByRole("link", { name: "Director" })).toHaveAttribute("href", "/");
    await expect
      .element(page.getByRole("link", { name: "Sign in" }))
      .toHaveAttribute("href", "/sign-in");
    // Nowhere to go before signing in.
    expect(page.getByRole("navigation", { name: "Main" }).query()).toBeNull();
  });

  it("holds a place for the account while the session loads", async () => {
    const page = await renderPage(<SiteHeader />, { url: "/" });
    const session = authClient.$store.atoms.session as unknown as {
      get(): object;
      set(value: object): void;
    };
    session.set({ ...session.get(), data: null, isPending: true });
    await expect.element(page.getByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    authClient.$store.notify("$sessionSignal");
    await expect.element(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  it("shows the account's menu, and the library as home", async () => {
    const user = await signUp();
    const page = await renderPage(<SiteHeader />, { url: "/settings" });
    await expect
      .element(page.getByRole("link", { name: "Director" }))
      .toHaveAttribute("href", "/library");
    // One workspace each, kept out of sight: no switcher, no language menu.
    expect(page.getByRole("button", { name: "Workspace" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Language" }).query()).toBeNull();
    await userEvent.click(page.getByRole("button", { name: user.name }));
    await expect.element(page.getByText(user.email)).toBeVisible();
  });

  it("leads to the library, marked as the page a member is on", async () => {
    await signUp();
    const page = await renderPage(<SiteHeader />, { url: "/settings" });
    const nav = page.getByRole("navigation", { name: "Main" });
    const library = nav.getByRole("link", { name: "Library" });
    await expect.element(library).not.toHaveAttribute("aria-current");
    await userEvent.click(library);
    await expect.poll(currentUrl).toBe("/library");
    const there = await renderPage(<SiteHeader />, { url: "/library" });
    await expect
      .element(there.getByRole("link", { name: "Library" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("goes to settings from the account's menu", async () => {
    const user = await signUp();
    const page = await renderPage(<SiteHeader />, { url: "/library" });
    await userEvent.click(page.getByRole("button", { name: user.name }));
    await userEvent.click(page.getByRole("menuitem", { name: "Settings" }));
    await expect.poll(currentUrl).toBe("/settings");
  });

  it("signs out with a full page load", async () => {
    const user = await signUp();
    const page = await renderPage(<SiteHeader />, { url: "/settings" });
    await userEvent.click(page.getByRole("button", { name: user.name }));
    await userEvent.click(page.getByRole("menuitem", { name: "Sign out" }));
    await expect.poll(commands.hardNavigations).toEqual([`${window.location.origin}/`]);
    expect(await fetch("/api/auth/get-session").then((r) => r.json())).toBeNull();
  });

  it("shows the account's picture when it has one", async () => {
    const user = await signUp();
    const image = `${window.location.origin}/picture.png`;
    await commands.sql('UPDATE auth."user" SET image = $1 WHERE id = $2', [image, user.id]);
    await signIn(user);
    const page = await renderPage(<SiteHeader />, { url: "/settings" });
    await expect.element(page.getByRole("button", { name: user.name })).toBeVisible();
    await expect
      .poll(
        () =>
          document.querySelector(`img[src="${image}"]`) ??
          document.querySelector("[data-slot=avatar-fallback]"),
      )
      .toBeTruthy();
  });
});
