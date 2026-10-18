import { expect, expectAccessible, settled, signOut, signUp, test } from "./support";

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
  for (const path of ["/", "/sign-in", "/sign-up", "/forgot-password", "/terms", "/privacy"]) {
    await page.goto(path);
  }
  await signUp(page);
  for (const path of ["/library", "/saved", "/settings", "/settings/security"]) {
    await page.goto(path);
    await settled(page);
  }
  expect(problems).toEqual([]);
});

test("health, robots, sitemap and manifest", async ({ request }) => {
  expect(await (await request.get("/healthz")).json()).toEqual({ status: "ok" });
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /library");
  expect(await (await request.get("/sitemap.xml")).text()).toContain("/terms");
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "Director", start_url: "/library" });
});

test("the API docs are reachable on the same origin", async ({ request }) => {
  const spec = await (await request.get("/api/v1/openapi.json")).json();
  expect(spec.info.title).toBe("Director API");
  expect(spec.paths["/me"]).toBeDefined();
});

test("the app is called Director everywhere a visitor or member looks", async ({ page }) => {
  // The template's name must not show anywhere: not in a title, not on the page.
  const namedDirector = async () => {
    await expect(page).toHaveTitle(/Director/);
    expect(await page.title()).not.toContain("Director-editor");
    await expect(page.locator("body")).not.toContainText("Director-editor");
  };
  for (const path of ["/", "/sign-in"]) {
    await page.goto(path);
    await namedDirector();
  }
  await signUp(page);
  await settled(page);
  await namedDirector();
});

test("the landing page shows Director and sends visitors to the demo", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Watch any Short. Shoot your own." }),
  ).toBeVisible();
  // The x-ray's real plan, the 6 seed templates and the Google Cloud services.
  await expect(
    page.getByRole("list", { name: "The plan's shots" }).getByRole("listitem"),
  ).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "Six Shorts, ready to shoot" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Built on Google Cloud" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Director-editor");
  await page.getByRole("link", { name: "Try the demo" }).first().click();
  await expect(page).toHaveURL(/\/sign-in\?demo=1$/);
});

test("the landing page stays public, signed in or not", async ({ page }) => {
  await signUp(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Try the demo" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open Director" }).first().click();
  await expect(page).toHaveURL(/\/library/);
});

test("workspace pages are gone", async ({ page }) => {
  await signUp(page);
  for (const path of [
    "/settings/workspace",
    "/settings/members",
    "/settings/billing",
    "/settings/api-keys",
    "/settings/webhooks",
    "/settings/audit",
    "/settings/notifications",
    "/notifications",
    "/dashboard",
  ]) {
    const response = await page.goto(path);
    expect({ path, status: response?.status() }).toEqual({ path, status: 404 });
  }
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
    for (const path of ["/library", "/saved", "/settings", "/settings/security"]) {
      await page.goto(path);
      await settled(page);
      await expectAccessible(page);
    }
  });

  test("dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    for (const path of ["/", "/sign-in"]) {
      await page.goto(path);
      await expectAccessible(page);
    }
    await signUp(page);
    for (const path of ["/library", "/settings/security"]) {
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
  await expect(page).toHaveURL(/\/library/);
});
