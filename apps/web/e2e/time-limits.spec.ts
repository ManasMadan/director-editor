import {
  ageSession,
  expect,
  expireCodes,
  mailbox,
  newUser,
  signIn,
  signUp,
  test,
  virtualAuthenticator,
} from "./support";

const THREE_HOURS = 3 * 60 * 60 * 1000;

test("an expired code says so; a new one works", async ({ page }) => {
  const user = newUser();
  const inbox = await mailbox(user.email);
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  const code = await inbox.nextCode();
  await expireCodes(user.email);

  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code has expired. Request a new one.")).toBeVisible();
  await page.getByRole("button", { name: "Resend code" }).click();
  await page.getByLabel("Verification code").fill(await inbox.nextCode());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("after the sudo window, the device list asks to sign in again and comes back", async ({
  page,
  context,
}) => {
  const user = await signUp(page);
  await ageSession(context, THREE_HOURS);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Signed-in devices" });
  await expect(
    card.getByText("For your security, sign in again to see or change this."),
  ).toBeVisible();
  await card.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Fsecurity/);
  await signIn(page, user, { expectUrl: /\/settings\/security$/ });
  await expect(card.getByText("This device")).toBeVisible();
});

test("after the sudo window, adding a passkey asks to sign in again", async ({ page, context }) => {
  const authenticator = await virtualAuthenticator(context, page);
  await signUp(page);
  await ageSession(context, THREE_HOURS);
  await page.goto("/settings/security");
  const card = page.locator("[data-slot=card]", { hasText: "Passkeys" });
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(card.getByRole("button", { name: "Sign in again" })).toBeVisible();
  expect(await authenticator.credentials()).toHaveLength(0);
});

test("the dashboard keeps working in an old session", async ({ page, context }) => {
  const user = await signUp(page);
  await ageSession(context, THREE_HOURS);
  await page.reload();
  await expect(page.getByRole("heading", { name: `Hi ${user.name}` })).toBeVisible();
});
