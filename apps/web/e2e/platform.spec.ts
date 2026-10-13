import {
  createWorkspace,
  expect,
  expectAccessible,
  settled,
  signOut,
  signUp,
  test,
} from "./support";

test("unknown pages show a translated 404", async ({ page }) => {
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("every page is served with a nonce CSP and security headers", async ({ page }) => {
  const response = await page.goto("/sign-in");
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-powered-by"]).toBeUndefined();
  // Two requests never share a nonce.
  const again = await page.request.get("/sign-in");
  expect(again.headers()["content-security-policy"]).not.toBe(csp);
});

test("no page logs errors or violates the CSP", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
  page.on("pageerror", (error) => problems.push(error.message));
  for (const path of [
    "/",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/terms",
    "/privacy",
    "/unsubscribe",
  ]) {
    await page.goto(path);
  }
  await signUp(page);
  for (const path of [
    "/dashboard",
    "/settings",
    "/settings/security",
    "/settings/notifications",
    "/settings/workspace",
    "/settings/members",
    "/settings/webhooks",
    "/settings/audit",
    "/notifications",
  ]) {
    await page.goto(path);
    await settled(page);
  }
  expect(problems).toEqual([]);
});

test("health, robots, sitemap and manifest", async ({ request }) => {
  expect(await (await request.get("/healthz")).json()).toEqual({ status: "ok" });
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /dashboard");
  expect(await (await request.get("/sitemap.xml")).text()).toContain("/terms");
  expect((await (await request.get("/manifest.webmanifest")).json()).start_url).toBe("/dashboard");
});

test("the API docs are reachable on the same origin", async ({ request }) => {
  const spec = await (await request.get("/api/v1/openapi.json")).json();
  expect(spec.paths["/todos"]).toBeDefined();
});

test.describe("accessibility (WCAG 2.2 AA)", () => {
  for (const path of [
    "/",
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/terms",
    "/does-not-exist",
  ]) {
    test(`public page ${path}`, async ({ page }) => {
      await page.goto(path);
      // A form's submit button waits for the captcha; check the page once it's usable.
      await expect(page.locator("button[type=submit]:disabled")).toHaveCount(0);
      await expectAccessible(page);
    });
  }

  test("signed-in pages", async ({ page }) => {
    await signUp(page);
    await createWorkspace(page, "Accessible");
    for (const path of [
      "/dashboard",
      "/settings",
      "/settings/security",
      "/settings/workspace",
      "/settings/members",
      "/settings/webhooks",
      "/settings/audit",
      "/settings/notifications",
      "/notifications",
    ]) {
      await page.goto(path);
      await settled(page);
      await expectAccessible(page);
    }
  });

  test("dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/sign-in");
    await expectAccessible(page);
    await signUp(page);
    for (const path of ["/dashboard", "/settings/security"]) {
      await page.goto(path);
      await settled(page);
      await expectAccessible(page);
    }
  });

  test("error states", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("time zone", () => {
  test.use({ timezoneId: "Asia/Tokyo" });
  test("the browser's zone is recorded so server-rendered dates use it", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect
      .poll(async () => (await context.cookies()).find((c) => c.name === "tz")?.value)
      .toBe("Asia%2FTokyo");
  });
});

test("theme can be switched and is remembered", async ({ page }) => {
  // The shared tokens (packages/ui theme.css) drive the colors in both themes: the page's
  // lightness (the browser reports colors as lab()) is white, then near black.
  const lightness = () =>
    page.evaluate(() =>
      Number(/lab\(([\d.]+)/.exec(getComputedStyle(document.body).backgroundColor)?.[1]),
    );
  await page.goto("/");
  await expect.poll(lightness).toBe(100);
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(lightness).toBeLessThan(15);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(lightness).toBeLessThan(15);
});

test("keyboard users can sign in without a mouse", async ({ page }) => {
  const user = await signUp(page);
  // Signing out reloads the page; wait for it, or the next navigation races it.
  await signOut(page, user);
  await page.goto("/sign-in");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(user.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type(user.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard/);
});
