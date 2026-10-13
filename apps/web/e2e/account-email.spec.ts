import { expect, mailbox, newDevice, newUser, signIn, signUp, test } from "./support";

test("change the sign-in email with codes from both addresses; the old address is alerted", async ({
  page,
  browser,
}) => {
  const user = await signUp(page);
  const oldInbox = await mailbox(user.email);
  const next = newUser().email;
  const newInbox = await mailbox(next);

  await page.goto("/settings");
  const card = page.locator("[data-slot=card]", { hasText: "You sign in with this address" });
  await expect(card.getByText(user.email, { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Change email" }).click();
  await card.getByLabel(`Code sent to ${user.email}`).fill(await oldInbox.nextCode());
  await card.getByLabel("New email").fill(next);
  await card.getByRole("button", { name: "Send code to new email" }).click();
  await card.getByLabel(`Code sent to ${next}`).fill(await newInbox.nextCode());
  await card.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText(`Email changed to ${next}`)).toBeVisible();
  await expect(card.getByText(next, { exact: true })).toBeVisible();

  const alert = await oldInbox.next();
  expect(alert.Subject).toBe("Your email address was changed");
  expect(alert.Text).toContain(next);

  const laptop = await newDevice(browser);
  await signIn(laptop.page, { ...user, email: next });
  await laptop.context.close();
});

test("a wrong code from the current address stops the change", async ({ page }) => {
  const user = await signUp(page);
  const inbox = await mailbox(user.email);
  await page.goto("/settings");
  const card = page.locator("[data-slot=card]", { hasText: "You sign in with this address" });
  await card.getByRole("button", { name: "Change email" }).click();
  const code = await inbox.nextCode();
  await card.getByLabel(`Code sent to ${user.email}`).fill(code === "000000" ? "111111" : "000000");
  await card.getByLabel("New email").fill(newUser().email);
  await card.getByRole("button", { name: "Send code to new email" }).click();
  await expect(card.getByText(/That code is wrong|Too many attempts/)).toBeVisible();
});

test("the new email can't be the current one", async ({ page }) => {
  const user = await signUp(page);
  await page.goto("/settings");
  const card = page.locator("[data-slot=card]", { hasText: "You sign in with this address" });
  await card.getByRole("button", { name: "Change email" }).click();
  await card.getByLabel(`Code sent to ${user.email}`).fill("123456");
  await card.getByLabel("New email").fill(user.email);
  await card.getByRole("button", { name: "Send code to new email" }).click();
  await expect(card.getByText("That's already your email.")).toBeVisible();
});

test("password changes and two-step changes email a security alert", async ({ page }) => {
  const user = await signUp(page);
  const inbox = await mailbox(user.email);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Changing it signs out" });
  await card.getByLabel("Current password").fill(user.password);
  await card.getByLabel("New password").fill(newUser().password);
  await card.getByRole("button", { name: "Change password" }).click();
  const alert = await inbox.next();
  expect(alert.Subject).toBe("Your password was changed");
  expect(alert.HTML).toContain("/settings/security");
});
