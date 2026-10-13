import { expect, mailbox, newDevice, sendReminder, signUp, test } from "./support";

test("a notification arrives live in the bell; opening it marks it read", async ({ page }) => {
  await signUp(page);
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell).toBeVisible();

  await sendReminder(page, "Water the plants");
  // No reload: the notification service's realtime nudge refreshes the bell.
  const unread = page.getByRole("button", { name: "1 unread notification" });
  await expect(unread).toBeVisible({ timeout: 20_000 });
  await unread.click();
  await page.getByRole("menuitem", { name: /Water the plants/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
});

test("the inbox lists everything and marks all read", async ({ page }) => {
  await signUp(page);
  await sendReminder(page, "First");
  await sendReminder(page, "Second");
  await expect(page.getByRole("button", { name: "2 unread notifications" })).toBeVisible({
    timeout: 20_000,
  });
  await page.goto("/notifications");
  await expect(page.getByRole("link", { name: /Second/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /First/ })).toBeVisible();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.getByRole("button", { name: "Notifications" })).toBeVisible();
});

test("turning off activity email keeps the in-app notification only", async ({ page }) => {
  const user = await signUp(page);
  await page.goto("/settings/notifications");
  await page
    .getByRole("group", { name: "Activity" })
    .getByRole("checkbox", { name: "Email" })
    .click();
  await expect(page.getByText("Notification settings saved")).toBeVisible();

  const inbox = await mailbox(user.email);
  const before = await inbox.count();
  await sendReminder(page, "In the app only");
  await expect(page.getByRole("button", { name: "1 unread notification" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(1_500);
  expect(await inbox.count()).toBe(before);
});

test("the email's unsubscribe link works signed out", async ({ page, browser }) => {
  const user = await signUp(page);
  const inbox = await mailbox(user.email);
  await sendReminder(page, "Unsubscribe me");
  const email = await inbox.next();
  const link = /(https?:\/\/\S+\/unsubscribe\?token=[\w.-]+)/.exec(email.Text)?.[1];
  expect(link, "an unsubscribe link in the email").toBeDefined();

  const stranger = await newDevice(browser);
  await stranger.page.goto(new URL(link as string).pathname + new URL(link as string).search);
  await stranger.page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(stranger.page.getByRole("status")).toHaveText(
    "Done. You won't get Activity emails anymore.",
  );
  await stranger.context.close();

  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("group", { name: "Activity" }).getByRole("checkbox", { name: "Email" }),
  ).not.toBeChecked();
});

test("digest and quiet hours are saved", async ({ page }) => {
  await signUp(page);
  await page.goto("/settings/notifications");
  await page.getByRole("checkbox", { name: "Daily digest" }).click();
  await expect(page.getByText("Notification settings saved")).toBeVisible();
  await page.getByRole("checkbox", { name: "Pause push and texts at night" }).click();
  await expect(page.getByLabel("From")).toHaveValue("22:00");
  await page.getByLabel("Until").fill("06:30");
  await page.getByLabel("From").focus();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Daily digest" })).toBeChecked();
  await expect(page.getByLabel("Until")).toHaveValue("06:30");
});

test("an invalid unsubscribe link explains itself", async ({ page }) => {
  await page.goto("/unsubscribe?token=not-a-real-token");
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByText(/This unsubscribe link isn't valid/)).toBeVisible();
});
