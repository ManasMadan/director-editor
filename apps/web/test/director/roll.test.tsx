/**
 * The shoot as one roll, against the real API (its recordings on the local storage): the
 * top band on a phone, and leaving mid-roll.
 */
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browser, commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { renderPage } from "../render";
import { currentSession, signUp } from "../users";
import { canvasCamera, fakeRecognizer, newVideoId, planShot, shotPlan } from "./support";

beforeEach(() => {
  fakeRecognizer();
  window.localStorage.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await browser.viewport(414, 896);
});

function ShootRoute({ videoId }: { videoId: string }) {
  const query = useSearchParams();
  return (
    <ShootPage
      videoId={videoId}
      shot={query.get("shot") ?? undefined}
      audio={query.get("audio") ?? undefined}
    />
  );
}

const shots = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    planShot({ title: `Shot ${index + 1}`, durationSeconds: 2 }),
  );

/**
 * A ready plan of `count` shots for the signed-in member: a row in the database too, as a
 * recording session belongs to its plan (the AI stand-in serves the rest).
 */
async function plannedShort(count: number) {
  const videoId = newVideoId();
  const { session } = await currentSession();
  const [row] = await commands.sql<{ id: string }>(
    `INSERT INTO ai.director_plan (org_id, video_id, source, status, stage, updated_at)
     VALUES ($1, $2, 'seed', 'ready', 'ready', now()) RETURNING id::text`,
    [session.activeOrganizationId, videoId],
  );
  await commands.fakeDirector(videoId, {
    plan: { id: row?.id, status: "ready", plan: shotPlan({ shots: shots(count) }) },
  });
  return videoId;
}

async function openShoot(videoId: string) {
  return renderPage(<ShootRoute videoId={videoId} />, {
    url: `/director/${videoId}/shoot?shot=0&audio=voice`,
  });
}

/** Starts shooting, and waits for the roll's indicator. */
async function startRoll(page: Awaited<ReturnType<typeof openShoot>>) {
  await userEvent.click(page.getByRole("button", { name: "Start shooting" }));
  await expect
    .element(page.getByRole("button", { name: "Pause recording" }), { timeout: 15_000 })
    .toBeVisible();
}

describe("the roll", { tags: ["files"] }, () => {
  it("keeps ✕ on a phone's screen with ten shots, and asks before leaving mid-roll", async () => {
    await browser.viewport(390, 844);
    canvasCamera();
    await signUp();
    const videoId = await plannedShort(10);
    const page = await openShoot(videoId);
    await startRoll(page);
    const leave = page.getByRole("link", { name: "Leave the shoot" });
    const box = leave.element().getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(390);
    expect(box.left).toBeGreaterThanOrEqual(0);
    // Every shot's dot is a full-size target, reachable by scrolling the strip.
    const dot = page
      .getByRole("button", { name: /^Shot 10:/ })
      .element()
      .getBoundingClientRect();
    expect(Math.min(dot.width, dot.height)).toBeGreaterThanOrEqual(44);

    await userEvent.click(leave);
    await expect.element(page.getByRole("alertdialog", { name: "Leave?" })).toBeVisible();
    await expect
      .element(page.getByText("Leaving ends this shoot.", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Stay" }));
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /Pause recording|Resume/ }))
      .toBeVisible();
  });
});
