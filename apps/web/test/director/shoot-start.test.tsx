/** The shoot screen before "Start shooting": a way out, and which short and shot it is. */
import { useSearchParams } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { newVideoId, planShot, readyPlan, shotPlan } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function ShootRoute({ videoId }: { videoId: string }) {
  const query = useSearchParams();
  return (
    <ShootPage
      videoId={videoId}
      shot={query.get("shot") ?? undefined}
      audio={query.get("audio") ?? undefined}
      back={query.get("back") ?? undefined}
    />
  );
}

async function openShoot(query = "shot=1&audio=voice") {
  const videoId = newVideoId();
  await readyPlan(
    videoId,
    shotPlan({
      title: "Morning routine",
      shots: [planShot({ title: "Walk in" }), planShot({ title: "Pour" })],
    }),
  );
  const page = await renderPage(<ShootRoute videoId={videoId} />, {
    url: `/director/${videoId}/shoot?${query}`,
  });
  return { page, videoId };
}

describe("before Start shooting", () => {
  it("says which short and shot this is, and ✕ leads back without starting", async () => {
    await signUp();
    const { page, videoId } = await openShoot();
    await expect.element(page.getByText("Morning routine")).toBeVisible();
    await expect.element(page.getByText("Shot 2 of 2")).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Leave the shoot" }));
    await expect.poll(currentUrl).toBe(`/director/${videoId}`);
  });

  it("leads back to the editor from a retake asked for there", async () => {
    await signUp();
    const { page, videoId } = await openShoot("shot=0&audio=voice&back=edit");
    await expect
      .element(page.getByRole("link", { name: "Leave the shoot" }))
      .toHaveAttribute("href", `/director/${videoId}/edit?audio=voice`);
  });
});
