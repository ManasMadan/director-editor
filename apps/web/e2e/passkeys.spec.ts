import { expect, signOut, signUp, test, virtualAuthenticator } from "./support";

test("add a passkey, then sign in with it (no password)", async ({ page, context }) => {
  const authenticator = await virtualAuthenticator(context, page);
  const user = await signUp(page);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Passkeys" });
  await expect(card.getByText("No passkeys yet.")).toBeVisible();
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove" })).toHaveCount(1);
  expect(await authenticator.credentials()).toHaveLength(1);

  await signOut(page, user);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: `Hi ${user.name}` })).toBeVisible();
});

test("dismissing the passkey prompt on sign-in says so", async ({ page, context }) => {
  // No passkey on this device: the browser's prompt ends without a credential, exactly
  // what happens when the user closes it.
  await virtualAuthenticator(context, page);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    page.getByText(
      "The passkey prompt was closed before finishing. Try again, or use your password.",
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("dismissing the prompt while adding a passkey says so and adds nothing", async ({
  page,
  context,
}) => {
  const authenticator = await virtualAuthenticator(context, page);
  await signUp(page);
  await page.goto("/settings/security");
  // The authenticator refuses user verification, as when the user cancels Touch ID.
  await authenticator.setVerified(false);
  const card = page.locator("[data-slot=card]", { hasText: "Passkeys" });
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(
    page.getByText(
      "The passkey prompt was closed before finishing. Try again, or use your password.",
    ),
  ).toBeVisible();
  await expect(card.getByText("No passkeys yet.")).toBeVisible();
});

test("a removed passkey can no longer sign in", async ({ page, context }) => {
  await virtualAuthenticator(context, page);
  const user = await signUp(page);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Passkeys" });
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(card.getByRole("button", { name: "Remove" })).toHaveCount(1);
  await card.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByText("No passkeys yet.")).toBeVisible();

  // The credential still exists on the device, but the server no longer accepts it.
  await signOut(page, user);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByText("This passkey isn't registered to any account.")).toBeVisible();
});

test("the same authenticator can't be added twice", async ({ page, context }) => {
  await virtualAuthenticator(context, page);
  await signUp(page);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Passkeys" });
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove" })).toHaveCount(1);
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("This passkey is already added.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove" })).toHaveCount(1);
});
