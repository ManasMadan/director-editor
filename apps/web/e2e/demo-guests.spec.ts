/**
 * The demo as a judge takes it: "Try it now, no sign-up" on the landing page signs the
 * browser in as a private guest of its own, straight into the library, and a second
 * judge on another device gets another guest that sees none of the first one's things.
 * The API gives guests out with DEMO_GUESTS=on: .env.example's value, and what
 * `bun run test:e2e` sets.
 */
import type { Page } from "@playwright/test";
import {
  asWorkspace,
  expect,
  expectAccessible,
  madeUpPlan,
  madeUpVideoId,
  newDevice,
  test,
} from "./support";

/** Who the page is signed in as, and in which workspace. */
const signedIn = async (page: Page) => {
  const session = await (await page.request.get("/api/auth/get-session")).json();
  return {
    userId: String(session.user.id),
    email: String(session.user.email),
    demo: Boolean(session.user.demo),
    orgId: String(session.session.activeOrganizationId),
  };
};

test("one tap on the landing page is a private demo, and another judge's is another", async ({
  page,
  browser,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try it now, no sign-up" }).first().click();
  await expect(page).toHaveURL(/\/library$/);
  const first = await signedIn(page);
  expect(first).toMatchObject({ demo: true });
  expect(first.email).toMatch(/@guest\.invalid$/);
  await expectAccessible(page);

  // Something of the first judge's own in their library.
  const title = `A judge's own Short ${madeUpVideoId()}`;
  await asWorkspace(first.orgId, (client) =>
    client.query(
      `INSERT INTO ai.director_plan
         (org_id, created_by, video_id, source, status, stage, plan, model, updated_at)
       VALUES ($1, $2, $3, 'user', 'ready', 'ready', $4, 'gemini-4-argon', now())`,
      [first.orgId, first.userId, madeUpVideoId(), madeUpPlan(title)],
    ),
  );

  // A second judge, on another device.
  const other = await newDevice(browser);
  await other.page.goto("/");
  await other.page.getByRole("link", { name: "Try it now, no sign-up" }).first().click();
  await expect(other.page).toHaveURL(/\/library$/);
  const second = await signedIn(other.page);
  expect(second.userId).not.toBe(first.userId);
  expect(second.orgId).not.toBe(first.orgId);

  const info = await (await request.post("/rpc/system/info", { data: { json: {} } })).json();
  if (info.json.features.director) {
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();
    // Both libraries have loaded the starters; only the first holds the judge's own.
    await expect(other.page.getByText(/^\d+ Shorts$/)).toBeVisible();
    await expect(other.page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  }
  await other.context.close();
});

test("a guest's demo card on the sign-in page says what the demo is", async ({ page }) => {
  await page.goto("/sign-in");
  const card = page.getByRole("region", { name: "Just looking? Use the demo." });
  await expect(
    card.getByText("Your footage is deleted after a day, and posting to YouTube is off."),
  ).toBeVisible();
  await card.getByRole("button", { name: "Use the demo" }).click();
  await expect(page).toHaveURL(/\/library$/);
  expect((await signedIn(page)).demo).toBe(true);
});
