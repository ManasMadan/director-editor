/**
 * Finishing a Short: the member's take of a seed template's shot, already reviewed, opens
 * in the editor; "Save video" puts it together in the browser, uploads it through the
 * real files flow (the worker checks it) and saves the cut, which My media then lists
 * under its template. The take is uploaded the way the camera screen uploads one, and its
 * review written as the AI service writes it, so no model is called.
 */
import type { Page } from "@playwright/test";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { required } from "@repo/contracts/objects";
import pg from "pg";
import { expect, expectAccessible, signUp, test } from "./support";

/** The one-shot seed: a single take makes a whole video. */
const seed = required(
  directorSeeds.find(
    (each) => each.plan.shots.length === 1 && each.plan.shots[0]?.kind === "video",
  ),
  "a seed template with one video shot",
);

/** A few seconds of a moving picture, recorded in the page as the camera screen would. */
const recordTake = (page: Page) =>
  page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 640;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    const timer = window.setInterval(() => {
      frame += 1;
      if (ctx) {
        ctx.fillStyle = `hsl(${(frame * 12) % 360} 70% 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }, 33);
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start(100);
    await new Promise((resolve) => window.setTimeout(resolve, 2500));
    recorder.stop();
    await stopped;
    window.clearInterval(timer);
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });

/** Uploads `bytes` as a take through the API and storage, and waits for the worker's check. */
async function uploadTake(page: Page, bytes: number[]) {
  const rpc = async (path: string, json: object) => {
    const response = await page.request.post(`/rpc/${path}`, { data: { json } });
    expect(response.ok()).toBe(true);
    return (await response.json()).json;
  };
  const created = await rpc("files/createUpload", {
    purpose: "director-take-video",
    filename: "shot-1.webm",
    contentType: "video/webm",
    size: bytes.length,
  });
  const headers = Object.fromEntries(
    Object.entries(created.upload.headers as Record<string, string>).filter(
      ([name]) => name.toLowerCase() !== "content-length",
    ),
  );
  const stored = await page.request.put(created.upload.url, {
    headers,
    data: Buffer.from(bytes),
  });
  expect(stored.ok()).toBe(true);
  const fileId: string = created.file.id;
  await rpc("files/completeUpload", { fileId });
  await expect
    .poll(async () => (await rpc("files/get", { fileId })).status, { timeout: 60_000 })
    .toBe("ready");
  return fileId;
}

/** Writes the take's review as the AI service does: its own role, scoped to the workspace. */
async function reviewedTake(orgId: string, userId: string, fileId: string) {
  const client = new pg.Client({ connectionString: process.env.AI_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query(
      `INSERT INTO ai.director_take
        (org_id, plan_id, user_id, shot_index, file_id, kind, status, best_start_ms,
         best_end_ms, score, feedback, updated_at)
       SELECT org_id, id, $2, 0, $3, 'video', 'ready', 200, 1800, 84, 'Steady and well lit.', now()
       FROM ai.director_plan WHERE org_id = $1 AND video_id = $4`,
      [orgId, userId, fileId, seed.videoId],
    );
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

test("a take becomes a saved video in My media", async ({ page, request }) => {
  const info = await (await request.post("/rpc/system/info", { data: { json: {} } })).json();
  test.skip(
    !info.json.features.director,
    "Director is off: the API needs YOUTUBE_API_KEY, the AI service and uploads",
  );
  test.setTimeout(120_000);

  await signUp(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const fileId = await uploadTake(page, await recordTake(page));
  await reviewedTake(session.session.activeOrganizationId, session.user.id, fileId);

  await page.goto(`/director/${seed.videoId}/edit?audio=original`);
  const shot = page.getByRole("group", { name: /^Shot 1 · / });
  await expect(shot.getByText("Director's pick")).toBeVisible();
  await expect(shot.getByText("Steady and well lit.")).toBeVisible();
  const save = page.getByRole("button", { name: "Save video" });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await expectAccessible(page);

  await save.click();
  const saved = page.getByRole("dialog", { name: "Saved to My media" });
  await expect(saved).toBeVisible({ timeout: 90_000 });
  await expectAccessible(page);
  await saved.getByRole("link", { name: "Open My media" }).click();

  await expect(page).toHaveURL(/\/media$/);
  await expect(page.getByRole("heading", { level: 2, name: seed.plan.title })).toBeVisible();
  await expect(page.getByText("1 video", { exact: true })).toBeVisible();
  await expect(page.getByText("Not published")).toBeVisible();
  await expectAccessible(page);
});
