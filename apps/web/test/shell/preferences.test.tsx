import { describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { DirectorPage } from "@/modules/director";
import { LiveUpdates, PreferenceSync, SiteHeader } from "@/modules/shell";
import { newVideoId, readyPlan, shotPlan } from "../director/support";
import { renderPage, router } from "../render";
import { api, signUp } from "../users";

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const cookie = (name: string) =>
  document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.split("=")[1];

describe("theme", () => {
  it.each(["Dark", "Light", "System"])("switches to the %s theme", async (theme) => {
    const page = await renderPage(<SiteHeader />, { url: "/" });
    await userEvent.click(page.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(page.getByRole("menuitem", { name: theme }));
    await expect.poll(() => localStorage.getItem("theme")).toBe(theme.toLowerCase());
  });
});

describe("preference sync", () => {
  it("renders in the browser's time zone", async () => {
    await signUp();
    // A zone that isn't the browser's, wherever the test runs (CI's runners are on UTC).
    const otherZone = browserZone === "UTC" ? "Asia/Tokyo" : "UTC";
    await renderPage(<PreferenceSync timeZone={otherZone} />, { url: "/library" });
    await expect.poll(() => decodeURIComponent(cookie("tz") ?? "")).toBe(browserZone);
    expect(router.refreshes).toBe(1);
  });

  it("changes nothing when the page already matches", async () => {
    await signUp();
    await renderPage(<PreferenceSync timeZone={browserZone} />, { url: "/library" });
    await renderPage(<p>rendered</p>, { url: "/library" });
    expect(router.refreshes).toBe(0);
  });
});

describe("live updates", () => {
  it("shows a change made elsewhere", async () => {
    await signUp();
    // A failed plan isn't polled, so only the realtime nudge can bring the new one in.
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, { plan: { status: "failed", error: null, plan: null } });
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
        <DirectorPage videoId={videoId} />
      </>,
      { url: `/director/${videoId}` },
    );
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.poll(() => streaming).toBe(true);
    await readyPlan(videoId, shotPlan());
    // What the AI service publishes once Director has worked the plan out.
    const me = await api.user.me();
    await commands.publishRealtime(`org:${me.activeOrganizationId}`, { type: "director.changed" });
    await expect.element(page.getByRole("heading", { name: "Morning routine" })).toBeVisible();
  });
});
