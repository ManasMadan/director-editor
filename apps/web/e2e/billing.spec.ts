/**
 * Billing through the whole stack: the web app, the API, a local fake Stripe (hosted
 * checkout and portal, signed webhooks), apps/webhooks, the outbox relay and the billing
 * consumer. Needs billing on with the fake running (`bun run stripe:fake`).
 */
import type { Browser, Page } from "@playwright/test";
import {
  createWorkspace,
  expect,
  inviteAndAccept,
  newDevice,
  signUp,
  test,
  upgrade,
} from "./support";

/** Someone new, signed up on their own device. */
async function someone(browser: Browser) {
  const device = await newDevice(browser);
  const user = await signUp(device.page);
  return { page: device.page, user };
}

async function billingCard(page: Page) {
  await page.goto("/settings/billing");
  return page.locator("[data-slot=card]", { hasText: "Current plan" });
}

test("a new workspace is on Free, with what that includes", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Starter");
  const card = await billingCard(page);
  await expect(card.getByText("Free", { exact: true })).toBeVisible();
  await expect(card.getByText("1 of 3 members")).toBeVisible();
  await expect(card.getByText("Not included")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade, billed monthly" })).toBeVisible();
  // Webhooks point to the upgrade instead of offering a form.
  await page.goto("/settings/webhooks");
  await expect(page.getByText(/Webhooks are part of Pro/)).toBeVisible();
  await expect(page.getByLabel("Endpoint URL")).toHaveCount(0);
  await page.getByRole("link", { name: "Upgrade to Pro" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
});

test("upgrading through checkout starts a trial and unlocks Pro", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Growing");
  await upgrade(page);
  await expect(page.getByText("Thanks! Your plan will update in a moment.")).toBeVisible();
  const card = page.locator("[data-slot=card]", { hasText: "Current plan" });
  await expect(card.getByText(/Free trial until/)).toBeVisible();
  await expect(card.getByText("1 member, no limit")).toBeVisible();
  await expect(page.getByRole("button", { name: /Upgrade, billed/ })).toHaveCount(0);
  // The first invoice (free during the trial).
  await expect(page.getByText("$0.00")).toBeVisible();
  await page.goto("/settings/webhooks");
  await expect(page.getByLabel("Endpoint URL")).toBeVisible();
});

test("a declined card keeps the workspace on Free", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Declined");
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Upgrade, billed yearly" }).click();
  await page.getByRole("button", { name: "Pay with a declined card" }).click();
  await expect(page.getByRole("alert")).toHaveText("Your card was declined.");
  await page.goto("/settings/billing");
  const card = page.locator("[data-slot=card]", { hasText: "Current plan" });
  await expect(card.getByText("Free", { exact: true })).toBeVisible();
});

test("going back from checkout changes nothing", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Undecided");
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Upgrade, billed monthly" }).click();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByRole("button", { name: "Upgrade, billed monthly" })).toBeVisible();
});

test("cancel in the billing portal: Pro stays until the period ends", async ({ page }) => {
  await signUp(page);
  await createWorkspace(page, "Leaving");
  await upgrade(page);
  await page.getByRole("button", { name: "Manage billing" }).click();
  await page.getByRole("button", { name: "Cancel plan" }).click();
  await expect(page.getByText(/cancels at the end of the period/)).toBeVisible();
  await page.getByRole("link", { name: "Return" }).click();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(page.getByText(/Cancelled: Pro stays until/)).toBeVisible({ timeout: 20_000 });
});

test("the Free plan's member limit stops invitations, with the reason", async ({
  page,
  browser,
}) => {
  await signUp(page);
  await createWorkspace(page, "Crowded");
  await inviteAndAccept(page, await someone(browser));
  await inviteAndAccept(page, await someone(browser));
  await page.goto("/settings/members");
  await expect(page.getByText(/Your plan allows 3 members/)).toBeVisible();
  await page.getByLabel("Email").fill(`e2e-extra-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(/member limit is reached/)).toBeVisible();
});

test("billing is for owners and admins only", async ({ page, browser }) => {
  await signUp(page);
  await createWorkspace(page, "Private books");
  const member = await someone(browser);
  await inviteAndAccept(page, member);
  await member.page.goto("/settings/workspace");
  await expect(member.page.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await member.page.goto("/settings/billing");
  await expect(member.page.getByRole("main").getByRole("alert")).toHaveText(
    "You don't have permission to do that.",
  );
});
