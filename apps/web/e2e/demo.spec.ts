/**
 * A judge tries Director in one click: the sign-in page offers the shared demo account,
 * and signing in with it lands in the library. The account is made the way production
 * makes it, by the API's own command (its DEMO_PASSWORD comes from the stack's
 * environment: the checkout's .env, or the one `bun run test:e2e` makes up for the run).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, expectAccessible, test } from "./support";

const DEMO_EMAIL = "demo@director.mmadan.in";

test.beforeAll(() => {
  // Safe to run again, against `bun dev`'s database too: it keeps what was done with the
  // account.
  execFileSync("bun", ["run", "--filter", "@repo/api", "director:demo-account", "--force"], {
    cwd: join(import.meta.dirname, "../../.."),
    stdio: "inherit",
  });
});

test("signs in with the demo account's card and lands in the library", async ({ page }) => {
  await page.goto("/sign-in");
  const card = page.getByRole("region", { name: "Try Director with the demo account" });
  await expect(card.getByText(DEMO_EMAIL)).toBeVisible();
  await expectAccessible(page);
  await card.getByRole("button", { name: "Use demo account" }).click();
  await expect(page.getByLabel("Email")).toHaveValue(DEMO_EMAIL);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});

test("the landing page's link fills the form with it", async ({ page }) => {
  await page.goto("/sign-in?demo=1");
  await expect(page.getByLabel("Email")).toHaveValue(DEMO_EMAIL);
  await expect(page.getByLabel("Password")).not.toHaveValue("");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});
