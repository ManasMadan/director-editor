import { expect, test } from "./support";

test("the Google button only appears when Google sign-in is configured", async ({
  page,
  request,
}) => {
  const info = await (await request.post("/rpc/system/info", { data: { json: {} } })).json();
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(
    info.json.features.google ? 1 : 0,
  );
});

// Needs real Google OAuth credentials (GOOGLE_CLIENT_ID/SECRET) and a Google test account
// (E2E_GOOGLE_EMAIL/E2E_GOOGLE_PASSWORD). Google blocks automated sign-in on most accounts,
// so this runs only when explicitly enabled.
test("sign in with Google", async ({ page }) => {
  test.skip(!process.env.E2E_GOOGLE_EMAIL, "set E2E_GOOGLE_EMAIL and E2E_GOOGLE_PASSWORD to run");
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByLabel(/email or phone/i).fill(process.env.E2E_GOOGLE_EMAIL as string);
  await page.getByRole("button", { name: /next/i }).click();
  await page.getByLabel(/enter your password/i).fill(process.env.E2E_GOOGLE_PASSWORD as string);
  await page.getByRole("button", { name: /next/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
});
