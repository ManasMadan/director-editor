import { enableTwoFactor, expect, newDevice, signIn, signOut, signUp, test, totp } from "./support";

test("turn on two-step verification, then sign in with an authenticator code", async ({
  page,
  browser,
}) => {
  const user = await signUp(page);
  const { secret } = await enableTwoFactor(page, user);

  const laptop = await newDevice(browser);
  await signIn(laptop.page, user, { expectUrl: /\/two-factor/ });
  // No session yet: the app is still out of reach.
  expect((await laptop.page.request.get("/api/v1/me")).status()).toBe(401);
  await laptop.page.getByLabel("Verification code").fill(totp(secret));
  await laptop.page.getByRole("button", { name: "Continue" }).click();
  await expect(laptop.page).toHaveURL(/\/dashboard/);
  await laptop.context.close();
});

test("a wrong authenticator code is rejected", async ({ page, browser }) => {
  const user = await signUp(page);
  const { secret } = await enableTwoFactor(page, user);
  const laptop = await newDevice(browser);
  await signIn(laptop.page, user, { expectUrl: /\/two-factor/ });
  const right = totp(secret);
  await laptop.page.getByLabel("Verification code").fill(right === "123456" ? "654321" : "123456");
  await laptop.page.getByRole("button", { name: "Continue" }).click();
  await expect(laptop.page.getByText("That code is wrong.")).toBeVisible();
  await expect(laptop.page).toHaveURL(/\/two-factor/);
  await laptop.context.close();
});

test("a backup code works once", async ({ page, browser }) => {
  const user = await signUp(page);
  const { backupCodes } = await enableTwoFactor(page, user);
  const code = backupCodes[0] as string;

  const first = await newDevice(browser);
  await signIn(first.page, user, { expectUrl: /\/two-factor/ });
  await first.page.getByRole("button", { name: "Use a backup code instead" }).click();
  await first.page.getByLabel("Backup code").fill(code);
  await first.page.getByRole("button", { name: "Continue" }).click();
  await expect(first.page).toHaveURL(/\/dashboard/);

  const second = await newDevice(browser);
  await signIn(second.page, user, { expectUrl: /\/two-factor/ });
  await second.page.getByRole("button", { name: "Use a backup code instead" }).click();
  await second.page.getByLabel("Backup code").fill(code);
  await second.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    second.page.getByText("That backup code is wrong or was already used."),
  ).toBeVisible();
  await Promise.all([first.context.close(), second.context.close()]);
});

test("a trusted device isn't asked again", async ({ page, browser }) => {
  const user = await signUp(page);
  const { secret } = await enableTwoFactor(page, user);
  const laptop = await newDevice(browser);
  await signIn(laptop.page, user, { expectUrl: /\/two-factor/ });
  await laptop.page.getByLabel("Verification code").fill(totp(secret));
  await laptop.page.getByRole("checkbox", { name: "Trust this device for 30 days" }).check();
  await laptop.page.getByRole("button", { name: "Continue" }).click();
  await expect(laptop.page).toHaveURL(/\/dashboard/);
  await signOut(laptop.page, user);
  await signIn(laptop.page, user);
  await laptop.context.close();
});

test("turning it off needs the password, then sign-in is one step again", async ({
  page,
  browser,
}) => {
  const user = await signUp(page);
  await enableTwoFactor(page, user);
  const card = page.locator("[data-slot=card]", { hasText: "Two-step verification" });
  await card.getByLabel("Confirm with your password").fill("wrong-password");
  await card.getByRole("button", { name: "Turn off" }).click();
  await expect(card.getByText("That password is wrong.")).toBeVisible();
  await card.getByLabel("Confirm with your password").fill(user.password);
  await card.getByRole("button", { name: "Turn off" }).click();
  await expect(card.getByRole("button", { name: "Turn on" })).toBeVisible();

  const laptop = await newDevice(browser);
  await signIn(laptop.page, user);
  await laptop.context.close();
});

test("the 2FA page without a pending sign-in can't be used", async ({ page }) => {
  await page.goto("/two-factor");
  await page.getByLabel("Verification code").fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This sign-in attempt expired. Sign in again.")).toBeVisible();
});
