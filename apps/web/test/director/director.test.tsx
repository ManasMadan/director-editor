/**
 * A template's page: the original and its storyboard, how each shot is filmed and what's
 * filmed of it, and the button to start; before that, Gemini at work or why it failed.
 */
import { fileIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { DirectorPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import { newVideoId, planShot, readyPlan, shotPlan, take } from "./support";

const fileId = () => fileIdSchema.parse(crypto.randomUUID());
const hero = () => document.querySelector("iframe") as HTMLIFrameElement;
const heroParams = () => new URL(hero().src).searchParams;

async function showPlan(videoId: string) {
  await signUp();
  return renderPage(<DirectorPage videoId={videoId} />, { url: `/director/${videoId}` });
}

describe("Director's page for a ready plan", () => {
  const plan = shotPlan({
    shots: [
      planShot({
        title: "Walk in",
        sourceStartSeconds: 1.2,
        sourceEndSeconds: 3.6,
        phoneAngle: { pitch: 15, roll: 0, tolerance: 6, height: "eye" },
        script: [{ startSeconds: 0, endSeconds: 1.5, text: "Morning, everyone!" }],
      }),
      planShot({
        kind: "photo",
        title: "The look",
        purpose: "End on a smile.",
        camera: "front",
        scene: "Kitchen",
        durationSeconds: 1.5,
        sourceStartSeconds: 4,
        sourceEndSeconds: 5.2,
        framing: {
          shotSize: "close-up",
          subject: { x: 0.2, y: 0.1, width: 0.6, height: 0.5 },
          note: "Fill the frame.",
        },
      }),
    ],
  });

  it("shows the short and what it takes, plays each shot's part, and starts filming", async () => {
    const videoId = newVideoId();
    await readyPlan(videoId, plan);
    const page = await showPlan(videoId);

    // The short's title is the page's heading, in a bar of its own above the player
    // (where YouTube's own title overlay can't be covered), with no "Director" pill.
    await expect
      .element(page.getByRole("heading", { level: 1, name: "Morning routine" }))
      .toBeVisible();
    expect(page.getByRole("banner").element().contains(hero())).toBe(false);
    expect(page.getByText("Director", { exact: true }).query()).toBeNull();
    await expect.element(page.getByRole("heading", { level: 3, name: "The look" })).toBeVisible();
    await expect.element(page.getByText("GRWM")).toBeVisible();
    await expect.element(page.getByText("01:15")).toBeVisible();
    await expect.element(page.getByText("2 shots", { exact: true })).toBeVisible();
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
    // Where to stand in the picture, how to hold the phone and what to say.
    await expect
      .element(page.getByRole("img", { name: "Medium shot: where you stand in the picture" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("img", { name: "Close-up: where you stand in the picture" }))
      .toBeVisible();
    await expect.element(page.getByText("Waist up.")).toBeVisible();
    await expect.element(page.getByText("Fill the frame.")).toBeVisible();
    await expect.element(page.getByText("Hold the phone at eye level")).toBeVisible();
    await expect.element(page.getByText("Tilted up 15°")).toBeVisible();
    await expect.element(page.getByText("Hold the phone at chest height")).toBeVisible();
    await expect.element(page.getByText("Held level")).toBeVisible();
    await expect.element(page.getByText("Morning, everyone!")).toBeVisible();
    // Nothing filmed yet: no take state on any shot.
    expect(page.getByText("Filmed", { exact: false }).query()).toBeNull();

    // Tapping a shot in the storyboard plays just its part of the original.
    const second = page
      .getByRole("list", { name: "Storyboard" })
      .getByRole("button", { name: "Watch shot 2: The look" });
    await userEvent.click(second);
    await expect.element(second).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Playing shot 2: The look")).toBeVisible();
    expect(heroParams().get("start")).toBe("4");
    expect(heroParams().get("end")).toBe("6");
    expect(heroParams().get("loop")).toBeNull();

    // Each shot card's button names its shot.
    await userEvent.click(page.getByRole("button", { name: "Watch shot 1: Walk in" }).last());
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
    await expect
      .element(page.getByRole("link", { name: "Back to the library" }))
      .toHaveAttribute("href", "/library");
    await expect
      .element(page.getByRole("link", { name: "Start shooting" }))
      .toHaveAttribute("href", `/director/${videoId}/shoot?shot=0&audio=original`);
    await userEvent.click(page.getByRole("link", { name: "Start shooting" }));
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
    await expect.element(page.getByText("You need 1 shot: 1 video and no photos.")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Start shooting" }))
      .toHaveAttribute("href", `/director/${videoId}/shoot?shot=0&audio=original`);
    await userEvent.click(page.getByRole("link", { name: "Start shooting" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=original`);
  });

  it.each([
    [false, "smooth"],
    [true, "auto"],
  ])(
    "scrolls back to the player (reduced motion: %s) with %s scrolling",
    async (reduce, behavior) => {
      const videoId = newVideoId();
      await readyPlan(videoId, plan);
      const matchMedia = window.matchMedia.bind(window);
      vi.spyOn(window, "matchMedia").mockImplementation((query) =>
        query === "(prefers-reduced-motion: reduce)"
          ? { ...matchMedia(query), matches: reduce }
          : matchMedia(query),
      );
      const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
      const page = await showPlan(videoId);
      await userEvent.click(page.getByRole("button", { name: "Watch shot 2: The look" }).first());
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior });
      vi.restoreAllMocks();
    },
  );

  it("says the mic will be used when the original's audio couldn't be fetched", async () => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, {
      plan: { status: "ready", plan: shotPlan(), audioStatus: "failed" },
    });
    const page = await showPlan(videoId);
    await expect
      .element(page.getByText("The original audio couldn't be fetched, so your mic will be used."))
      .toBeVisible();
    expect(page.getByRole("radio").query()).toBeNull();
    await userEvent.click(page.getByRole("link", { name: "Start shooting" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=0&audio=voice`);
  });

  it("shows what's filmed of each shot, and picks up at the first shot not filmed", async () => {
    const videoId = newVideoId();
    const shots = ["One", "Two", "Three", "Four"].map((title) => planShot({ title }));
    await commands.fakeDirector(videoId, {
      plan: { status: "ready", plan: shotPlan({ shots }) },
      takes: [
        take({ fileId: fileId(), shotIndex: 0, score: 82 }),
        take({ fileId: fileId(), shotIndex: 1, score: 40 }),
        take({ fileId: fileId(), shotIndex: 3, status: "reviewing" }),
      ],
    });
    const page = await showPlan(videoId);
    await expect.element(page.getByText("Filmed, 82/100")).toBeVisible();
    await expect.element(page.getByText("Needs a retake (40/100)")).toBeVisible();
    await expect.element(page.getByText("Director is reviewing your take")).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Continue shooting" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=2&audio=voice`);
  });

  it("says a take is filmed before Director has scored it", async () => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, {
      plan: { status: "ready", plan: shotPlan() },
      takes: [take({ fileId: fileId(), status: "failed" })],
    });
    const page = await showPlan(videoId);
    await expect.element(page.getByText("Filmed", { exact: true })).toBeVisible();
    // Every shot has a take: starting again from the top.
    await expect.element(page.getByRole("link", { name: "Start shooting" })).toBeVisible();
  });
});

describe("Director's page before the plan is ready", () => {
  it.each([
    ["pending", "queued", "Waiting for Gemini"],
    ["analyzing", "watching", "Gemini is watching the Short"],
    ["analyzing", "writing", "Writing the shot list"],
  ])("shows Gemini at work while the plan is %s (%s)", async (status, stage, message) => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, { plan: { status, stage, plan: null } });
    const page = await showPlan(videoId);
    await expect.element(page.getByRole("status", { name: message })).toBeVisible();
    await expect
      .element(page.getByText("This takes about a minute.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Director" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back to the library" }))
      .toHaveAttribute("href", "/library");
  });

  it.each([
    [
      "DIRECTOR_VIDEO_UNREADABLE",
      "Director couldn't watch this short. It may be private, age-restricted or removed.",
    ],
    [null, "Director couldn't work out how to film this short. Try again."],
  ])("says why indexing failed (%s), and leads back to the library", async (error, message) => {
    const videoId = newVideoId();
    await commands.fakeDirector(videoId, {
      plan: { status: "failed", stage: "failed", error, plan: null },
    });
    const page = await showPlan(videoId);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    await expect
      .element(
        page.getByText("A Short that couldn't be indexed doesn't use up your own.", {
          exact: false,
        }),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Go to the library" }))
      .toHaveAttribute("href", "/library");
    // Indexing again is the library's to offer: nothing here asks for it.
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    expect(await commands.answeredRequests("/rpc/director/index")).toBe(0);
  });

  it("never indexes a short just because it was opened, and points to the library", async () => {
    const videoId = newVideoId();
    const page = await showPlan(videoId);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This Short isn't in your library yet.");
    await expect
      .element(page.getByRole("link", { name: "Go to the library" }))
      .toHaveAttribute("href", "/library");
    expect(await commands.answeredRequests("/rpc/director/index")).toBe(0);
  });

  it("says when the plan can't be read, and reads it again without indexing", async () => {
    const videoId = newVideoId();
    await commands.failRequests("/rpc/director/plan", { status: 502 });
    const page = await showPlan(videoId);
    await expect.element(page.getByRole("alert")).toBeVisible();
    const tried = await commands.failedRequests("/rpc/director/plan");
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect.poll(() => commands.failedRequests("/rpc/director/plan")).toBeGreaterThan(tried);
    expect(await commands.answeredRequests("/rpc/director/index")).toBe(0);
  });
});
