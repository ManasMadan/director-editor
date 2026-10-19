/**
 * The shoot as one roll, against the real API (its recordings on the local storage): the
 * top band on a phone, leaving mid-roll, and a session left behind by a closed tab.
 */
import { useSearchParams } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browser, commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { cleanup, renderPage } from "../render";
import { api, currentSession, signUp } from "../users";
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

  it("records in a new part when the camera's picture changes size", async () => {
    canvasCamera();
    await signUp();
    const videoId = await plannedShort(2);
    const page = await openShoot(videoId);
    await startRoll(page);
    const [session] = await api.recording.sessions();
    if (!session) {
      throw new Error("the roll opened no session");
    }
    const parts = async () =>
      (await api.recording.session({ sessionId: session.id })).parts.map((part) => part.index);
    expect(await parts()).toEqual([0]);
    // The camera settles on another size (or the phone turns): its frames change size.
    const shown = document.querySelector("video")?.srcObject;
    const [track] = shown instanceof MediaStream ? shown.getVideoTracks() : [];
    if (!(track instanceof CanvasCaptureMediaStreamTrack)) {
      throw new Error("the viewfinder isn't showing the canvas camera");
    }
    track.canvas.width = 640;
    track.canvas.height = 360;
    await expect.poll(parts, { timeout: 10_000 }).toEqual([0, 1]);
  });

  it("finishes the session when the page goes, and carries on an open one on return", async () => {
    canvasCamera();
    await signUp();
    const videoId = await plannedShort(2);
    const first = await openShoot(videoId);
    await startRoll(first);
    const [opened] = await api.recording.sessions();
    expect(opened?.status).toBe("recording");
    // The tab closes (no unmount): the session ends there.
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    await expect
      .poll(async () => (await api.recording.sessions())[0]?.status, { timeout: 10_000 })
      .toBe("done");
    cleanup();

    // A session a dead tab left open (no pagehide got through) is carried on, not doubled.
    const again = await plannedShort(2);
    const left = await api.recording.start({ videoId: again });
    canvasCamera();
    const page = await openShoot(again);
    await startRoll(page);
    const sessions = (await api.recording.sessions()).filter(
      (session) => session.videoId === again,
    );
    expect(sessions.map((session) => session.id)).toEqual([left.id]);
    const detail = await api.recording.session({ sessionId: left.id });
    expect(detail.parts.map((part) => part.index)).toEqual([0]);
  });
});
