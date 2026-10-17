import { expect, newDevice, newUser, signIn, signUp, test } from "./support";

test.describe("profile", () => {
  test("change the display name", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings");
    await page.getByLabel("Name").fill("Renamed Person");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Renamed Person" })).toBeVisible();
  });

  test("an empty name is refused", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings");
    await page.getByLabel("Name").fill("   ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
  });

  test("the time zone can be changed", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings");
    await page.getByLabel("Time zone").selectOption("Asia/Tokyo");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
  });
});

test.describe("signed-in devices", () => {
  test("lists devices and signs out a single one", async ({ page, browser }) => {
    const user = await signUp(page);
    const laptop = await newDevice(browser);
    await signIn(laptop.page, user);

    await page.goto("/settings/security");
    const card = page.locator("[data-slot=card]", { hasText: "Signed-in devices" });
    await expect(card.getByRole("listitem")).toHaveCount(2);
    await expect(card.getByText("This device")).toBeVisible();
    await card.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(card.getByRole("listitem")).toHaveCount(1);

    await laptop.page.goto("/library");
    await expect(laptop.page).toHaveURL(/\/sign-in/);
    // This device is untouched.
    await page.goto("/library");
    await expect(page).toHaveURL(/\/library/);
    await laptop.context.close();
  });
});

test.describe("password", () => {
  test("change the password; other devices are signed out", async ({ page, browser }) => {
    const user = await signUp(page);
    const laptop = await newDevice(browser);
    await signIn(laptop.page, user);

    await page.goto("/settings/security");
    const card = page.locator("[data-slot=card]", { hasText: "Changing it signs out" });
    const next = newUser().password;
    await card.getByLabel("Current password").fill(user.password);
    await card.getByLabel("New password").fill(next);
    await card.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed")).toBeVisible();

    await laptop.page.goto("/library");
    await expect(laptop.page).toHaveURL(/\/sign-in/);
    await signIn(laptop.page, { ...user, password: next });
    await page.goto("/library");
    await expect(page).toHaveURL(/\/library/);
    await laptop.context.close();
  });

  test("the current password must be right", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings/security");
    const card = page.locator("[data-slot=card]", { hasText: "Changing it signs out" });
    await card.getByLabel("Current password").fill("wrong-password");
    await card.getByLabel("New password").fill(newUser().password);
    await card.getByRole("button", { name: "Change password" }).click();
    await expect(card.getByText("That password is wrong.")).toBeVisible();
  });
});

test.describe("delete account", () => {
  test("needs the password, then the account is gone for good", async ({ page }) => {
    const user = await signUp(page);
    await page.goto("/settings/security");
    const card = page.locator("[data-slot=card]", { hasText: "Delete account" });
    await card.getByLabel("Enter your password to confirm").fill("wrong-password");
    await card.getByRole("button", { name: "Delete my account" }).click();
    await expect(card.getByText("That password is wrong.")).toBeVisible();

    await card.getByLabel("Enter your password to confirm").fill(user.password);
    await card.getByRole("button", { name: "Delete my account" }).click();
    await expect(page.getByText("Your account was deleted")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That email and password don't match.")).toBeVisible();
  });
});
