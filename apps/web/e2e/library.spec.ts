/**
 * The library's one rule a member can trip over: one short of their own. A second link
 * is refused by the API (DIRECTOR_INDEX_LIMIT) and the library says the AI credit is used,
 * offering the starter templates, without adding anything.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, expectAccessible, signUp, test } from "./support";

/** A real, public video under three minutes ("Me at the zoo"): the API checks it on YouTube. */
const PUBLIC_SHORT = "jNQXAC9IVRw";

const plan = (title: string) => ({
  title,
  format: "GRWM",
  summary: "Coffee, a window and a smile.",
  audio: "speech",
  durationSeconds: 3,
  shots: [
    {
      kind: "video",
      title: "Walk in",
      purpose: "Set the scene.",
      sourceStartSeconds: 0,
      sourceEndSeconds: 3,
      durationSeconds: 3,
      camera: "back",
      scene: "By a window",
      sceneLandmark: "window",
      framing: {
        shotSize: "medium",
        subject: { x: 0.25, y: 0.2, width: 0.5, height: 0.7 },
        note: "Waist up.",
      },
      phoneAngle: { pitch: 0, roll: 0, tolerance: 6, height: "chest" },
      pose: { description: "Standing.", keypoints: [] },
      steps: [{ atSeconds: 0, instruction: "Walk towards the camera.", cameraMove: "static" }],
      script: [],
    },
  ],
});

/** An 11-character id no real video has, for rows the test makes itself. */
const madeUpVideoId = () => `t${randomUUID().replaceAll("-", "").slice(0, 10)}`;

/**
 * Runs `work` as the AI service does: its own database role, inside a transaction scoped
 * to the workspace by row-level security.
 */
async function asWorkspace<T>(orgId: string, work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: process.env.AI_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

/** Plans written straight into the library: one the member indexed, and a starter. */
const fillLibrary = (orgId: string, userId: string, starterTitle: string) =>
  asWorkspace(orgId, async (client) => {
    const insert = `INSERT INTO ai.director_plan
      (org_id, created_by, video_id, source, status, stage, plan, model, updated_at)
      VALUES ($1, $2, $3, $4, 'ready', 'ready', $5, 'gemini-4-argon', now())`;
    await client.query(insert, [orgId, userId, madeUpVideoId(), "user", plan("My own short")]);
    await client.query(insert, [orgId, null, madeUpVideoId(), "seed", plan(starterTitle)]);
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
  await page
    .getByLabel("YouTube Shorts link")
    .fill(`https://www.youtube.com/shorts/${PUBLIC_SHORT}`);
  await page.getByRole("button", { name: "Index it" }).click();

  const dialog = page.getByRole("dialog", { name: "You've used your AI credit" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: starter })).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toBeHidden();
  // The refusal used up nothing more and added nothing.
  expect(await ownShorts(orgId, userId)).toBe(1);
  await expect(page.getByText("2 Shorts")).toBeVisible();

  // The starter it offered opens.
  await page.getByRole("link", { name: new RegExp(starter) }).click();
  await expect(page).toHaveURL(/\/director\/t[\w-]{10}$/);
  await expect(page.getByRole("heading", { name: starter })).toBeVisible();
});
