/**
 * The shared demo account, as the demo's fallback: when the API can't make a guest (the
 * demo is full), the sign-in page offers the shared account instead, filled in the form,
 * and signing in with it lands in the library. The account is made the way production
 * makes it, by the API's own command (its DEMO_PASSWORD comes from the stack's
 * environment: the checkout's .env, or the one `bun run test:e2e` makes up for the run).
 * demo-guests.spec.ts covers the demo itself.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, expectAccessible, test } from "./support";

const DEMO_EMAIL = "demo@director.mmadan.in";

// One worker for the file, so the account is made once: two workers' first runs at once
// would both try to create it.
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Safe to run again, against `bun dev`'s database too: it keeps what was done with the
  // account.
  execFileSync("bun", ["run", "--filter", "@repo/api", "director:demo-account", "--force"], {
    cwd: join(import.meta.dirname, "../../.."),
    stdio: "inherit",
  });
});

test("falls back to the shared demo account when no guest can be made", async ({ page }) => {
  // The demo is full: what the API answers past DEMO_GUEST_LIMIT.
  await page.route("**/api/auth/sign-in/guest", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "DEMO_GUESTS_FULL", message: "Full." }),
    }),
  );
  await page.goto("/sign-in?demo=1");
  await expect(page.getByRole("alert")).toContainText("Your own demo couldn't start just now.");
  const card = page.getByRole("region", { name: "Try Director with the demo account" });
  await expect(card.getByText(DEMO_EMAIL)).toBeVisible();
  await expectAccessible(page);
  await expect(page.getByLabel("Email")).toHaveValue(DEMO_EMAIL);
  await expect(page.getByLabel("Password")).not.toHaveValue("");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
});
