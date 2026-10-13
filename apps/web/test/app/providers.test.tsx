/** What the app does when any API call says the session, the app or the workspace is gone. */
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { AssistantPage } from "@/modules/assistant";
import { DashboardPage } from "@/modules/dashboard";
import { currentUrl, renderPage } from "../render";
import { auth, currentSession, signOut, signUp } from "../users";

describe("the app's providers", () => {
  it("send a signed-out user to sign in, and back to this page afterwards", async () => {
    await signUp();
    await signOut();
    await renderPage(<DashboardPage />, { url: "/dashboard?tab=1" });
    await expect.poll(currentUrl).toBe("/sign-in?next=%2Fdashboard%3Ftab%3D1");
  });

  it("stay on an auth page when the session ends there", async () => {
    await signUp();
    await signOut();
    await renderPage(<DashboardPage />, { url: "/sign-in" });
    // The failed calls signed out what was left of the session; nothing moved.
    // The test signed out once itself; the rest are the app (once per failed call).
    await expect.poll(() => commands.answeredRequests("/api/auth/sign-out")).toBeGreaterThan(1);
    expect(currentUrl()).toBe("/sign-in");
    expect(await commands.hardNavigations()).toEqual([]);
    // Nothing navigates the page's queries away, and they stop asking anyway: no API
    // call is answered while a request of the test's own goes out and back.
    const callsDuringARoundTrip = async () => {
      const before = await commands.answeredRequests("/rpc/");
      await currentSession();
      return (await commands.answeredRequests("/rpc/")) - before;
    };
    await expect.poll(callsDuringARoundTrip).toBe(0);
  });

  it("reload the page when the API asks for a newer app", async () => {
    await signUp();
    await commands.requestHeaders({ "x-app-version": "0.0.1" });
    await renderPage(<DashboardPage />, { url: "/dashboard" });
    // Each call that was refused reloads; the first is what the user sees.
    await expect
      .poll(async () => new Set(await commands.hardNavigations()))
      .toEqual(new Set([`${window.location.origin}/dashboard`]));
  });

  it("move to another workspace when the active one is gone", async () => {
    await signUp();
    await auth("/organization/set-active", { organizationId: null });
    // Two calls fail together; the app switches once.
    await renderPage(
      <>
        <DashboardPage />
        <AssistantPage />
      </>,
      { url: "/settings" },
    );
    await expect.poll(commands.hardNavigations).toEqual([`${window.location.origin}/dashboard`]);
    const session = await currentSession();
    expect(session.session.activeOrganizationId).toEqual(expect.any(String));
  });
});
