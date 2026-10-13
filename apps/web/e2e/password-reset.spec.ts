import { expect, mailbox, newDevice, newUser, signIn, signUp, test } from "./support";

test("reset a forgotten password; every device is signed out", async ({ page, browser }) => {
  const user = await signUp(page);
  const phone = await newDevice(browser);
  await signIn(phone.page, user);

  const reset = await newDevice(browser);
  const inbox = await mailbox(user.email);
  await reset.page.goto("/sign-in");
  await reset.page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(reset.page).toHaveURL(/\/forgot-password/);
  await reset.page.getByLabel("Email").fill(user.email);
  await reset.page.getByRole("button", { name: "Send code" }).click();
  await expect(reset.page).toHaveURL(/\/reset-password\?email=/);

  const newPassword = newUser().password;
  await reset.page.getByLabel("Verification code").fill(await inbox.nextCode());
  await reset.page.getByLabel("New password").fill(newPassword);
  await reset.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    reset.page.getByText("Password updated. Sign in with your new password."),
  ).toBeVisible();
  await expect(reset.page).toHaveURL(/\/sign-in/);

  // Both previously signed-in devices lost their sessions.
  for (const device of [page, phone.page]) {
    await device.goto("/dashboard");
    await expect(device).toHaveURL(/\/sign-in/);
  }

  // The old password no longer works; the new one does.
  await reset.page.getByLabel("Email").fill(user.email);
  await reset.page.getByLabel("Password").fill(user.password);
  await reset.page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(reset.page.getByText("That email and password don't match.")).toBeVisible();
  await signIn(reset.page, { ...user, password: newPassword });
  await Promise.all([phone.context.close(), reset.context.close()]);
});

test("an unknown email gets the same answer (no account enumeration)", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(newUser().email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page).toHaveURL(/\/reset-password\?email=/);
});

test("a wrong reset code is rejected", async ({ page, browser }) => {
  const user = await signUp(page);
  const other = await newDevice(browser);
  await other.page.goto("/forgot-password");
  await other.page.getByLabel("Email").fill(user.email);
  await other.page.getByRole("button", { name: "Send code" }).click();
  await other.page.getByLabel("Verification code").fill("000000");
  await other.page.getByLabel("New password").fill(newUser().password);
  await other.page.getByRole("button", { name: "Continue" }).click();
  await expect(other.page.getByText(/That code is wrong|Too many attempts/)).toBeVisible();
  await other.context.close();
});

test("reset pages without an email go back to the start", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page).toHaveURL(/\/forgot-password/);
  await page.goto("/verify-email?email=not-an-email");
  await expect(page).toHaveURL(/\/sign-in/);
});
