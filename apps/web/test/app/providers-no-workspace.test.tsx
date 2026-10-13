/** A separate page: the app switches workspace at most once per page load. */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { DashboardPage } from "@/modules/dashboard";
import { renderPage } from "../render";
import { auth, signUp } from "../users";

it("stays put when the workspaces can't be listed", async () => {
  await signUp();
  await auth("/organization/set-active", { organizationId: null });
  await commands.failRequests("/api/auth/organization/list", { status: 502 });
  await renderPage(<DashboardPage />, { url: "/dashboard" });
  await expect.poll(() => commands.failedRequests("/api/auth/organization/list")).toBe(1);
  expect(await commands.hardNavigations()).toEqual([]);
});
