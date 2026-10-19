/**
 * The library's one rule a member can trip over: one short of their own. A second link
 * is refused by the API (DIRECTOR_INDEX_LIMIT) and the library says the AI credit is used,
 * offering the starter templates, without adding anything.
 */
import { randomUUID } from "node:crypto";
import {
  asWorkspace,
  expect,
  expectAccessible,
  madeUpPlan,
  madeUpVideoId,
  signUp,
  test,
} from "./support";

/** A real, public video under three minutes ("Me at the zoo"): the API checks it on YouTube. */
const PUBLIC_SHORT = "jNQXAC9IVRw";

/** Plans written straight into the library: one the member indexed, and a starter. */
const fillLibrary = (orgId: string, userId: string, starterTitle: string) =>
  asWorkspace(orgId, async (client) => {
    const insert = `INSERT INTO ai.director_plan
      (org_id, created_by, video_id, source, status, stage, plan, model, updated_at)
      VALUES ($1, $2, $3, $4, 'ready', 'ready', $5, 'gemini-4-argon', now())`;
    await client.query(insert, [
      orgId,
      userId,
      madeUpVideoId(),
      "user",
      madeUpPlan("My own short"),
    ]);
    await client.query(insert, [orgId, null, madeUpVideoId(), "seed", madeUpPlan(starterTitle)]);
  });

/** How many plans in the workspace the member indexed. */
const ownShorts = (orgId: string, userId: string) =>
  asWorkspace(orgId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*) FROM ai.director_plan WHERE created_by = $1",
      [userId],
    );
    return Number(rows[0]?.count);
  });

test("a second short of your own is refused, with the starters offered instead [RF 1]", async ({
  page,
  request,
}) => {
  const info = await (await request.post("/rpc/system/info", { data: { json: {} } })).json();
  test.skip(
    !info.json.features.director,
    "Director is off: the API needs YOUTUBE_API_KEY, the AI service and uploads",
  );

  await signUp(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const starter = `Office GRWM ${randomUUID().slice(0, 6)}`;
  const orgId: string = session.session.activeOrganizationId;
  const userId: string = session.user.id;
  await fillLibrary(orgId, userId, starter);

  await page.goto("/library");
  await expect(page.getByText("You've added your own Short.", { exact: false })).toBeVisible();
  // The six seed templates the workspace started with, and the two written above.
  const count = page.getByText(/^\d+ Shorts$/);
  const before = await count.textContent();
  await page
    .getByLabel("YouTube Shorts link")
    .fill(`https://www.youtube.com/shorts/${PUBLIC_SHORT}`);
  await page.getByRole("button", { name: "Index it" }).click();

  const dialog = page.getByRole("dialog", { name: "You've already added your own Short" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: starter })).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("YouTube Shorts link")).toBeFocused();
  // The refusal used up nothing more and added nothing.
  expect(await ownShorts(orgId, userId)).toBe(1);
  await expect(count).toHaveText(before ?? "");

  // The starter it offered opens.
  await page.getByRole("link", { name: new RegExp(starter) }).click();
  await expect(page).toHaveURL(/\/director\/t[\w-]{10}$/);
  await expect(page.getByRole("heading", { level: 1, name: starter })).toBeVisible();
});
