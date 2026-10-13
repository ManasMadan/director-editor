import { describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { DashboardPage } from "@/modules/dashboard";
import { LiveUpdates, PreferenceSync, SiteHeader } from "@/modules/shell";
import { renderPage, router } from "../render";
import { api, auth, signUp } from "../users";

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const cookie = (name: string) =>
  document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")[1];
const forget = (name: string) => cookieStore.delete(name);

describe("language and theme", () => {
  it("switches the language for a visitor with a cookie", async () => {
    await forget("locale");
    const page = await renderPage(<SiteHeader />, { url: "/" });
    await userEvent.click(page.getByRole("button", { name: "Language" }));
    await expect
      .element(page.getByRole("menuitem", { name: "English" }))
      .toHaveAttribute("aria-current", "true");
    await userEvent.click(page.getByRole("menuitem", { name: "español" }));
    await expect.poll(() => cookie("locale")).toBe("es");
    expect(router.refreshes).toBe(1);
  });

  it("saves a signed-in user's choice to their account", async () => {
    await signUp();
    const page = await renderPage(<SiteHeader />, { url: "/dashboard" });
    await userEvent.click(page.getByRole("button", { name: "Language" }));
    await userEvent.click(page.getByRole("menuitem", { name: "español" }));
    await expect.poll(async () => (await api.user.me()).locale).toBe("es");
    await expect.poll(() => router.refreshes).toBe(1);
  });

  it.each(["Dark", "Light", "System"])("switches to the %s theme", async (theme) => {
    const page = await renderPage(<SiteHeader />, { url: "/" });
    await userEvent.click(page.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(page.getByRole("menuitem", { name: theme }));
    await expect.poll(() => localStorage.getItem("theme")).toBe(theme.toLowerCase());
  });
});

describe("preference sync", () => {
  it("renders in the account's saved language and the browser's time zone", async () => {
    await signUp();
    await auth("/update-user", { locale: "es" });
    await forget("locale");
    // A zone that isn't the browser's, wherever the test runs (CI's runners are on UTC).
    const otherZone = browserZone === "UTC" ? "Asia/Tokyo" : "UTC";
    await renderPage(<PreferenceSync timeZone={otherZone} />, { url: "/dashboard" });
    await expect.poll(() => cookie("locale")).toBe("es");
    expect(decodeURIComponent(cookie("tz") ?? "")).toBe(browserZone);
    expect(router.refreshes).toBe(1);
  });

  it("changes nothing when the page already matches", async () => {
    await signUp();
    await renderPage(<PreferenceSync timeZone={browserZone} />, { url: "/dashboard" });
    await renderPage(<p>rendered</p>, { url: "/dashboard" });
    expect(router.refreshes).toBe(0);
  });
});

describe("live updates", () => {
  it("shows a change made in another tab", async () => {
    await signUp();
    // Seen from the page's own requests: when the realtime stream has started answering.
    let streaming = false;
    const fetch = window.fetch;
    vi.spyOn(window, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0] instanceof Request ? args[0].url : args[0]).includes("/rpc/realtime/")) {
        streaming = true;
      }
      return response;
    });
    const page = await renderPage(
      <>
        <LiveUpdates />
        <DashboardPage />
      </>,
      { url: "/dashboard" },
    );
    await expect.element(page.getByText("Nothing to do. Add your first todo above.")).toBeVisible();
    await expect.poll(() => streaming).toBe(true);
    await api.todo.create({ title: "Made elsewhere" });
    // What the worker publishes once the outbox relays the change.
    const me = await api.user.me();
    await commands.publishRealtime(`org:${me.activeOrganizationId}`, { type: "todos.changed" });
    await expect.element(page.getByText("Made elsewhere")).toBeVisible();
  });
});
