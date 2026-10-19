/**
 * The shoot screen before "Start shooting": a way out and where you are, a card that
 * fits a phone held sideways, and copy that says what this account really records.
 */
import { useSearchParams } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page as browser, commands, userEvent } from "vitest/browser";
import { ShootPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { demoAccount, signIn, signUp } from "../users";
import { newVideoId, planShot, readyPlan, shotPlan } from "./support";

afterEach(async () => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  await browser.viewport(414, 896);
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
    // A member's own shoot records the whole time, and the card says so.
    await expect
      .element(page.getByText("Director records the whole time", { exact: false }))
      .toBeVisible();
    expect(page.getByText("On the shared demo account", { exact: false }).query()).toBeNull();
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

  it("fits the whole card on a phone held sideways, using its width", async () => {
    await browser.viewport(844, 390);
    await signUp();
    const { page } = await openShoot();
    const heading = page.getByRole("heading", { name: "Let's shoot this together" });
    await expect.element(heading).toBeVisible();
    expect(heading.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    const start = page.getByRole("button", { name: "Start shooting" }).element();
    expect(start.getBoundingClientRect().bottom).toBeLessThanOrEqual(390);
    // Wider than the 9:16 column (about 220 px at this height) the camera fills.
    const card = page.getByRole("region", { name: "Let's shoot this together" }).element();
    expect(card.getBoundingClientRect().width).toBeGreaterThan(400);
  });

  it("tells the shared demo account up front that takes record on the shutter", async () => {
    // The shared account, as the API knows it: its address, flagged as the demo (the
    // tests' database starts without it, so it's made or found here, then signed in to
    // afresh for a session that carries the flag).
    const user = await demoAccount();
    await commands.sql('UPDATE auth."user" SET demo = true WHERE id = $1', [user.id]);
    await signIn(user);
    const { page } = await openShoot();
    await expect
      .element(page.getByText("A take records only when you tap the shutter.", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("On the shared demo account", { exact: false }))
      .toBeVisible();
    expect(page.getByText("records the whole time", { exact: false }).query()).toBeNull();
  });
});
