/** Director's page for a short: the plan as it's worked out, then what it takes to film it. */
import { describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { DirectorPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { newVideoId, readyPlan, shot, shotPlan } from "./support";

const hero = () => document.querySelector("iframe") as HTMLIFrameElement;
const heroParams = () => new URL(hero().src).searchParams;

async function showPlan(videoId: string) {
  await signUp();
  return renderPage(<DirectorPage videoId={videoId} />, { url: `/director/${videoId}` });
}

describe("Director's page for a ready plan", () => {
  const plan = shotPlan({
    shots: [
      shot({ title: "Walk in", sourceStartSeconds: 1.2, sourceEndSeconds: 3.6 }),
      shot({
        kind: "photo",
        title: "The look",
        purpose: "End on a smile.",
        camera: "front",
        scene: "Kitchen",
        durationSeconds: 1.5,
        sourceStartSeconds: 4,
        sourceEndSeconds: 5.2,
      }),
    ],
  });

  it("shows the short and what it takes, plays each shot's part, and starts filming", async () => {
    const videoId = newVideoId();
    await readyPlan(videoId, plan);
    const page = await showPlan(videoId);

    await expect.element(page.getByRole("heading", { name: "Morning routine" })).toBeVisible();
    await expect.element(page.getByText("GRWM")).toBeVisible();
    await expect.element(page.getByText("01:15")).toBeVisible();
    await expect.element(page.getByText("2 shots", { exact: true })).toBeVisible();
    await expect.element(page.getByText("1 video · 1 photo")).toBeVisible();
    await expect.element(page.getByText("You need 2 shots: 1 video and 1 photo.")).toBeVisible();
    await expect.element(page.getByText("Coffee, a window and a smile.")).toBeVisible();
    // The whole short loops, muted, until a shot is picked.
    expect(heroParams().get("loop")).toBe("1");
    expect(heroParams().get("mute")).toBe("1");

    // The list says how each shot is filmed.
    await expect.element(page.getByText("End on a smile.")).toBeVisible();
    await expect.element(page.getByText("Front camera")).toBeVisible();
    await expect.element(page.getByText("Back camera")).toBeVisible();
    await expect.element(page.getByText("1.5 s")).toBeVisible();
    await expect.element(page.getByText("Kitchen")).toBeVisible();

    // Tapping a shot in the storyboard plays just its part of the original.
    const second = page.getByRole("button", { name: "Watch shot 2: The look" });
    await userEvent.click(second);
    await expect.element(second).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Playing shot 2: The look")).toBeVisible();
    expect(heroParams().get("start")).toBe("4");
    expect(heroParams().get("end")).toBe("6");
    expect(heroParams().get("loop")).toBeNull();

    await userEvent.click(page.getByRole("button", { name: "Watch this part" }).first());
    await expect.element(page.getByText("Playing shot 1: Walk in")).toBeVisible();
    await expect.element(second).toHaveAttribute("aria-pressed", "false");
    expect(heroParams().get("start")).toBe("1");

    await userEvent.click(page.getByRole("button", { name: "Watch the whole short" }));
    await expect.element(page.getByText("Playing shot", { exact: false })).not.toBeInTheDocument();
    expect(heroParams().get("loop")).toBe("1");

    // The sound comes on and goes off again.
    await userEvent.click(page.getByRole("button", { name: "Unmute" }));
    await userEvent.click(page.getByRole("button", { name: "Mute" }));
    await expect.element(page.getByRole("button", { name: "Unmute" })).toBeVisible();

    // A short with speech asks whose voice it has: the member's, unless they pick the original.
    await expect.element(page.getByRole("radio", { name: "I'll speak" })).toBeChecked();
    await userEvent.click(page.getByText("Use the original audio"));
    await expect.element(page.getByRole("radio", { name: "Use the original audio" })).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Use template" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
  });

  it.each([
    ["music", "This short is set to music: you'll film along to the original audio."],
    ["none", "This short has no sound to match."],
  ] as const)("doesn't ask about speech in a short with %s", async (audio, note) => {
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan({ audio }));
    const page = await showPlan(videoId);
    await expect.element(page.getByText(note)).toBeVisible();
    expect(page.getByRole("radio").query()).toBeNull();
    await expect.element(page.getByText("1 video · no photos")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Use template" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
  });
});

describe("Director's page before the plan is ready", () => {
  it.each([
    ["pending", "Director is getting ready…"],
    ["analyzing", "Director is watching the short…"],
  ] as const)("says Director is at work while the plan is %s", async (status, message) => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, { plan: { status, plan: null } });
    const page = await showPlan(videoId);
    await expect.element(page.getByText(message)).toBeVisible();
    await expect.element(page.getByText("This takes about a minute.")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Director" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/shorts/${videoId}`);
  });

  it.each([
    [
      "DIRECTOR_VIDEO_UNREADABLE",
      "Director couldn't watch this short. It may be private, age-restricted or removed.",
    ],
    [null, "Director couldn't work out how to film this short. Try again."],
  ])("says why the plan failed (%s), and asks again", async (error, message) => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, { plan: { status: "failed", error, plan: null } });
    await commands.failRequests("/rpc/director/requestPlan", { status: 502 });
    const page = await showPlan(videoId);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect.poll(() => commands.failedRequests("/rpc/director/requestPlan")).toBe(1);
    await expect.element(page.getByRole("alert")).not.toHaveTextContent(message);
  });

  it("asks Director for a plan nobody has asked for yet, and again after a failure", async () => {
    const videoId = newVideoId();
    // The API checks the short on YouTube first, which isn't reachable here: as if the
    // gateway couldn't reach the API.
    await commands.failRequests("/rpc/director/requestPlan", { status: 502 });
    const page = await showPlan(videoId);
    await expect.poll(() => commands.failedRequests("/rpc/director/requestPlan")).toBe(1);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect.poll(() => commands.failedRequests("/rpc/director/requestPlan")).toBe(2);
  });

  it("says when the plan can't be read", async () => {
    const videoId = newVideoId();
    await commands.failRequests("/rpc/director/plan", { status: 502 });
    const page = await showPlan(videoId);
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(await commands.failedRequests("/rpc/director/requestPlan")).toBe(0);
  });
});
