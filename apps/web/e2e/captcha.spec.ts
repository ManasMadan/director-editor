import { BASE_URL, expect, mailbox, newUser, test } from "./support";

// Runs when the API has Turnstile configured. With Cloudflare's always-pass test keys
// (see .env.example) it checks the real widget and token flow end to end; it needs
// internet access to challenges.cloudflare.com.
test.describe("captcha", () => {
  test.use({ realTurnstile: true });

  test.beforeEach(async ({ request }) => {
    const info = await (await request.post("/rpc/system/info", { data: { json: {} } })).json();
    test.skip(
      !info.json.features.captcha,
      "captcha is off (set TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY on the API)",
    );
  });

  test("sign-up waits for the widget, then goes through", async ({ page }) => {
    const user = newUser();
    const inbox = await mailbox(user.email);
    await page.goto("/sign-up");
    await expect(page.getByTestId("captcha")).toBeAttached();
    await page.getByLabel("Full name").fill(user.name);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    const submit = page.getByRole("button", { name: "Create account" });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();
    await expect(page).toHaveURL(/\/verify-email/);
    await inbox.nextCode();
  });

  test("forgot password goes through the widget too", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(newUser().email);
    const submit = page.getByRole("button", { name: "Send code" });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();
    await expect(page).toHaveURL(/\/reset-password/);
  });

  test("a blocked widget explains itself instead of leaving the form stuck", async ({ page }) => {
    await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
    await page.goto("/sign-up");
    await expect(
      page.getByRole("alert").filter({ hasText: "The security check couldn't load." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeDisabled();
  });

  test("the API refuses a sign-up without a token", async ({ request }) => {
    const user = newUser();
    const response = await request.post("/api/auth/sign-up/email", {
      data: user,
      headers: { origin: BASE_URL },
    });
    expect(response.status()).toBe(400);
  });
});
