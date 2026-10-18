/**
 * A template's page: the original and its storyboard, how each shot is filmed and what's
 * filmed of it, and the button to start; before that, Gemini at work or why it failed.
 */
import { directorSeeds } from "@repo/contracts/director-seeds";
import { fileIdSchema } from "@repo/contracts/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { DirectorPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { signUp } from "../users";
import {
  newVideoId,
  photo,
  planShot,
  readyPlan,
  recordVideo,
  shotPlan,
  silentWav,
  take,
} from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

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

/** A blob's bytes as base64, for `serveRequests`. */
async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/**
 * Storage's answers for a seed's media, which the local stack doesn't hold: a picture for
 * every storyboard card, a clip for every preview and a track for the music.
 */
async function serveSeedMedia() {
  const [picture, clip, track] = await Promise.all([
    photo(),
    recordVideo(1),
    fetch(silentWav(2)).then((response) => response.blob()),
  ]);
  await commands.serveRequests(String.raw`/seed-media/.+\.png\?`, {
    contentType: "image/jpeg",
    base64: await base64(picture),
  });
  await commands.serveRequests(String.raw`/seed-media/.+\.mp4\?`, {
    contentType: "video/webm",
    base64: await base64(clip),
  });
  await commands.serveRequests(String.raw`/seed-media/.+/music\.mp3\?`, {
    contentType: "audio/wav",
    base64: await base64(track),
  });
}

describe("a seeded template's media", () => {
  const seed = directorSeeds.find(({ videoId }) => videoId === "_HonL1arbaA");
  if (!seed) {
    throw new Error("the seed this test reads is gone");
  }
  const [first, second] = seed.plan.shots;
  const seeded = (source: "seed" | "user" = "seed") =>
    commands.fakeDirector(seed.videoId, { plan: { status: "ready", source, plan: seed.plan } });
  const altOf = (shot = first) => `Storyboard for ${shot?.title}: ${shot?.scene}`;
  const card = (shot = first) =>
    [...document.querySelectorAll("img")].find((image) => image.alt === altOf(shot)) ?? null;
  const videos = () => [...document.querySelectorAll("video")];
  // The music plays from an Audio of its own, outside the page: found by what it plays.
  const played = () => vi.spyOn(HTMLMediaElement.prototype, "play");
  let play: ReturnType<typeof played>;
  beforeEach(() => {
    play = played();
  });
  const soundtrack = () =>
    play.mock.contexts
      .filter((media) => media instanceof HTMLMediaElement)
      .find((media) => media.src.includes("/music.mp3"));
  const planReads = () => commands.answeredRequests("/rpc/director/plan");
  const sketches = (page: Awaited<ReturnType<typeof showPlan>>) =>
    page.getByRole("img", { name: /where you stand in the picture/ }).elements().length;

  it("shows each shot's Nano Banana storyboard, plays its Veo preview in place, and the Lyria soundtrack", async () => {
    await serveSeedMedia();
    await seeded();
    const page = await showPlan(seed.videoId);

    // Every shot's card shows its storyboard, loaded lazily, with nothing playing yet.
    await expect.element(page.getByAltText(altOf())).toBeVisible();
    expect(card()?.getAttribute("loading")).toBe("lazy");
    expect(card()?.src).toContain(`seed-media/${seed.videoId}/shot-0.png`);
    card()?.scrollIntoView();
    await expect.poll(() => card()?.naturalWidth).toBeGreaterThan(0);
    expect(page.getByText("Storyboard by Nano Banana").elements()).toHaveLength(
      seed.plan.shots.length,
    );
    expect(videos()).toEqual([]);

    // Tapped, the shot's preview plays in its place: muted, looping, inline.
    await userEvent.click(page.getByRole("button", { name: "Play the Veo preview of shot 1" }));
    await expect.poll(() => videos().length).toBe(1);
    const [clip] = videos();
    expect(clip?.src).toContain(`seed-media/${seed.videoId}/shot-0.mp4`);
    expect(clip?.muted).toBe(true);
    expect(clip?.loop).toBe(true);
    expect(clip?.playsInline).toBe(true);
    await expect.poll(() => clip?.paused).toBe(false);
    await expect.element(page.getByText("Preview made with Veo")).toBeVisible();
    expect(card()).toBeNull();

    // One at a time: the next shot's preview stops this one.
    await userEvent.click(page.getByRole("button", { name: "Play the Veo preview of shot 2" }));
    await expect
      .poll(() => videos().map((video) => video.src))
      .toEqual([expect.stringContaining(`seed-media/${seed.videoId}/shot-1.mp4`)]);
    expect(card()).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Pause the preview of shot 2" }));
    expect(videos()).toEqual([]);
    expect(card(second)).not.toBeNull();

    // The seed's music, on a player of its own, loaded only once it's played.
    await expect.element(page.getByText("Soundtrack, made with Lyria")).toBeVisible();
    expect(await commands.answeredRequests("/music.mp3")).toBe(0);
    await userEvent.click(page.getByRole("button", { name: "Play the soundtrack" }));
    expect(soundtrack()?.src).toContain(`seed-media/${seed.videoId}/music.mp3`);
    await expect.poll(() => soundtrack()?.paused).toBe(false);
    await userEvent.click(page.getByRole("button", { name: "Pause the soundtrack" }));
    await expect.poll(() => soundtrack()?.paused).toBe(true);
    await expect.element(page.getByRole("button", { name: "Play the soundtrack" })).toBeVisible();
    // Nothing failed, so the plan was read once.
    expect(await planReads()).toBe(1);
  });

  it("shows no media on a member's own plan, even of the same Short", async () => {
    await serveSeedMedia();
    await seeded("user");
    const page = await showPlan(seed.videoId);
    await expect.element(page.getByRole("heading", { level: 3, name: first?.title })).toBeVisible();
    expect(card()).toBeNull();
    expect(page.getByText("Storyboard by Nano Banana").query()).toBeNull();
    expect(page.getByText("Soundtrack, made with Lyria").query()).toBeNull();
    expect(page.getByRole("button", { name: /Veo preview/ }).query()).toBeNull();
    // The cards look as they always have: the framing sketch where a storyboard would be.
    expect(sketches(page)).toBe(seed.plan.shots.length);
  });

  it("reads the plan again once for links that ran out, then leaves out what still fails", async () => {
    await serveSeedMedia();
    await commands.failRequests(".mp4?", { status: 403 });
    await commands.failRequests("music.mp3?", { status: 403 });
    await seeded();
    const page = await showPlan(seed.videoId);
    const play = page.getByRole("button", { name: "Play the Veo preview of shot 1" });
    await userEvent.click(play);
    // The clip's link failed: the plan is read again for fresh links, and the card is back.
    await expect.poll(planReads).toBe(2);
    await expect.element(play).toBeVisible();
    expect(card()).not.toBeNull();
    // Failing again so soon, it isn't read a third time: the clip is left out.
    await userEvent.click(play);
    await expect
      .element(page.getByRole("button", { name: /preview of shot 1$/ }))
      .not.toBeInTheDocument();
    expect(card()).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Play the soundtrack" }));
    await expect.element(page.getByText("Soundtrack, made with Lyria")).not.toBeInTheDocument();
    expect(await planReads()).toBe(2);
  });

  it("never shows a broken storyboard: one that won't load gives way to the framing sketch", async () => {
    // A seed of its own: a link signed in the same second as another test's is the same
    // link, and the browser would show the picture it kept from then.
    const other = directorSeeds.find(({ videoId }) => videoId === "WvGUjw7OwZo");
    if (!other) {
      throw new Error("the seed this test reads is gone");
    }
    await commands.failRequests("/seed-media/", { status: 403 });
    await commands.fakeDirector(other.videoId, {
      plan: { status: "ready", source: "seed", plan: other.plan },
    });
    const page = await showPlan(other.videoId);
    // Each card loads as it comes near the screen.
    const scrolledThrough = () => {
      for (const image of document.querySelectorAll("img")) {
        image.scrollIntoView();
      }
    };
    await expect
      .element(page.getByRole("heading", { level: 3, name: other.plan.shots[0]?.title }))
      .toBeVisible();
    await expect
      .poll(() => {
        scrolledThrough();
        return planReads();
      })
      .toBe(2);
    await expect
      .poll(() => {
        scrolledThrough();
        return other.plan.shots.filter((shot) => card(shot)).length;
      })
      .toBe(0);
    expect(page.getByText("Storyboard by Nano Banana").query()).toBeNull();
    expect(sketches(page)).toBe(other.plan.shots.length);
    expect(await planReads()).toBe(2);
  });
});
