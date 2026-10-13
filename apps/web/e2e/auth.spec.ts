import {
  BASE_URL,
  expect,
  mailbox,
  newDevice,
  newUser,
  signIn,
  signOut,
  signUp,
  test,
} from "./support";

test.describe("sign-up and verification", () => {
  test("sign up, verify by email, land on the dashboard", async ({ page }) => {
    const user = await signUp(page);
    await expect(page.getByRole("heading", { name: `Hi ${user.name}` })).toBeVisible();
  });

  test("a wrong code is rejected and a new one can be requested", async ({ page }) => {
    const user = newUser();
    const inbox = await mailbox(user.email);
    await page.goto("/sign-up");
    await page.getByLabel("Full name").fill(user.name);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    const first = await inbox.nextCode();

    const wrong = first === "000000" ? "111111" : "000000";
    await page.getByLabel("Verification code").fill(wrong);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That code is wrong or has expired.")).toBeVisible();

    await page.getByRole("button", { name: "Resend code" }).click();
    await expect(page.getByText("A new code is on its way.")).toBeVisible();
    const second = await inbox.nextCode();
    await page.getByLabel("Verification code").fill(second);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("an existing email can't sign up twice", async ({ page, browser }) => {
    const user = await signUp(page);
    const other = await newDevice(browser);
    await other.page.goto("/sign-up");
    await other.page.getByLabel("Full name").fill("Someone");
    await other.page.getByLabel("Email").fill(user.email);
    await other.page.getByLabel("Password").fill(newUser().password);
    await other.page.getByRole("button", { name: "Create account" }).click();
    // better-auth hides whether the email exists: the flow continues to verification,
    // and no session is created for the impostor.
    await expect(other.page).toHaveURL(/\/verify-email/);
    await other.page.goto("/dashboard");
    await expect(other.page).toHaveURL(/\/sign-in/);
    await other.context.close();
  });

  test("signing in before verifying sends a fresh code and continues to verification", async ({
    page,
  }) => {
    const user = newUser();
    const inbox = await mailbox(user.email);
    await page.goto("/sign-up");
    await page.getByLabel("Full name").fill(user.name);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await inbox.next();

    await page.goto("/sign-in");
    await signIn(page, user, { expectUrl: /\/verify-email/ });
    await page.getByLabel("Verification code").fill(await inbox.nextCode());
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("forms validate with the server's rules before submitting", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password").fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page.getByText("Use at least 8 characters")).toBeVisible();
    await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/sign-up/);
  });
});

test.describe("sign-in and sign-out", () => {
  test("after sign-out the old session cookie no longer works", async ({ page, browser }) => {
    const user = await signUp(page);
    const stolen = await page.context().cookies();
    await signOut(page, user);

    // Replay the cookie from before sign-out on another device: rejected.
    const thief = await newDevice(browser);
    await thief.context.addCookies(stolen);
    const me = await thief.page.request.get("/api/v1/me");
    expect(me.status()).toBe(401);
    await thief.page.goto("/dashboard");
    await expect(thief.page).toHaveURL(/\/sign-in\?next=%2Fdashboard/);
    await thief.context.close();
  });

  test("wrong password shows a translated error", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(newUser().email);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That email and password don't match.")).toBeVisible();
  });

  test("too many attempts are rate limited with a clear message", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(newUser().email);
    await page.getByLabel("Password").fill("not-the-password");
    const submit = page.getByRole("main").getByRole("button", { name: "Sign in", exact: true });
    for (let attempt = 0; attempt < 6; attempt++) {
      await submit.click();
      await expect(submit).toBeEnabled();
    }
    await expect(page.getByText("Too many attempts. Wait a minute and try again.")).toBeVisible();
  });

  test("signed-out visitors are sent to sign-in and returned where they were going", async ({
    page,
  }) => {
    const user = await signUp(page);
    await signOut(page, user);
    await page.goto("/settings/security");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Fsecurity/);
    await signIn(page, user, { expectUrl: /\/settings\/security$/ });
  });

  test("a ?next= pointing at another site is ignored", async ({ page }) => {
    const user = await signUp(page);
    await signOut(page, user);
    for (const next of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
      await signIn(page, user);
      expect(new URL(page.url()).origin).toBe(BASE_URL);
      await signOut(page, user);
    }
  });

  test("signed-in users skip the auth pages", async ({ page }) => {
    await signUp(page);
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/sign-up");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("a session revoked elsewhere sends this device to sign-in instead of looping", async ({
    page,
    browser,
  }) => {
    const user = await signUp(page);
    const laptop = await newDevice(browser);
    await signIn(laptop.page, user);
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Sign out of all other devices" }).click();
    await expect(page.getByText("Signed out").first()).toBeVisible();

    await laptop.page.reload();
    await expect(laptop.page).toHaveURL(/\/sign-in\?next=%2Fdashboard/);
    // The stale cookie is gone, so the sign-in page stays put.
    await laptop.page.waitForTimeout(500);
    await expect(laptop.page).toHaveURL(/\/sign-in/);
    await laptop.context.close();
  });
});

test.describe("language", () => {
  test.use({ locale: "es-ES" });
  test("renders in the browser's language, and emails match", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByText("Bienvenido de nuevo")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");

    const user = newUser();
    const inbox = await mailbox(user.email);
    await page.goto("/sign-up");
    await page.getByLabel("Nombre completo").fill(user.name);
    await page.getByLabel("Correo electrónico").fill(user.email);
    await page.getByLabel("Contraseña").fill(user.password);
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    const email = await inbox.next();
    expect(email.Subject).toBe("Verifica tu correo");
  });
});
