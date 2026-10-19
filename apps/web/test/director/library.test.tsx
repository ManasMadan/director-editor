/**
 * The library: the workspace's templates, and indexing a short of the member's own, with
 * Director's progress followed live and a second short refused with the starters offered.
 */
import { describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { LibraryPage } from "@/modules/director";
import { LiveUpdates } from "@/modules/shell";
import { currentUrl, renderPage } from "../render";
import { currentSession, signUp } from "../users";
import { newVideoId, planShot, shotPlan } from "./support";

/** A member of a workspace of their own, and its id (the AI stand-in keeps a library each). */
async function member() {
  await signUp();
  const { session } = await currentSession();
  return String(session.activeOrganizationId);
}

const seed = (title: string, videoId = newVideoId()) => ({
  videoId,
  source: "seed",
  status: "ready",
  stage: "ready",
  plan: shotPlan({
    title,
    durationSeconds: 26,
    shots: [planShot({ durationSeconds: 2 }), planShot({ kind: "photo", durationSeconds: 1 })],
  }),
});

const showLibrary = () =>
  renderPage(
    <>
      <LiveUpdates />
      <LibraryPage />
    </>,
    { url: "/library" },
  );

const link = () => page.getByLabelText("YouTube Shorts link");

describe("the library", () => {
  it("shows the workspace's templates: starters and members' own, ready or still indexing", async () => {
    const orgId = await member();
    const grwm = seed("Office GRWM");
    const mine = newVideoId();
    const indexing = newVideoId();
    const broken = newVideoId();
    await commands.fakeLibrary(orgId, {
      templates: [
        { videoId: indexing, status: "analyzing", stage: "writing", plan: null },
        { videoId: broken, status: "failed", stage: "failed", plan: null },
        { ...seed("My dance", mine), source: "user" },
        grwm,
      ],
    });
    await showLibrary();

    await expect
      .element(page.getByRole("heading", { level: 1, name: "Pick a Short. Shoot your own." }))
      .toBeVisible();
    await expect.element(page.getByText("4 Shorts")).toBeVisible();
    const starter = page.getByRole("link", { name: /Office GRWM/ });
    await expect.element(starter).toHaveAttribute("href", `/director/${grwm.videoId}`);
    await expect.element(starter).toMatchTextContent(/Starter/);
    await expect.element(starter).toMatchTextContent(/2 shots/);
    await expect.element(starter).toMatchTextContent(/00:26/);
    await expect.element(page.getByRole("link", { name: /My dance/ })).toMatchTextContent(/Yours/);
    // Not ready yet: what Gemini is doing, or that it failed, on the picture.
    await expect
      .element(page.getByRole("link", { name: /Writing the shot list/ }))
      .toHaveAttribute("href", `/director/${indexing}`);
    await expect
      .element(page.getByRole("link", { name: /Couldn't index/ }))
      .toHaveAttribute("href", `/director/${broken}`);
  });

  it("puts the head-nod starter first, as the quick start anyone can shoot indoors alone", async () => {
    const orgId = await member();
    await commands.fakeLibrary(orgId, {
      templates: [seed("Office GRWM"), seed("4 Variations of the Indian Head Nod", "22k0fZarxh8")],
    });
    await showLibrary();
    const quick = page.getByRole("link", { name: /Quick start/ });
    // Straight to the shoot: quick means no template page to read first.
    await expect.element(quick).toHaveAttribute("href", "/director/22k0fZarxh8/shoot");
    await expect.element(quick).toMatchTextContent(/4 Variations of the Indian Head Nod/);
    await expect.element(quick).toMatchTextContent(/Just you, talking to the camera\./);
    // Under the heading, before the cards to index or describe a short: above a phone's fold.
    const index = page.getByRole("button", { name: "Index it" }).element();
    expect(
      quick.element().compareDocumentPosition(index) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers no quick start while that starter isn't in the library", async () => {
    const orgId = await member();
    await commands.fakeLibrary(orgId, { templates: [seed("Office GRWM")] });
    await showLibrary();
    await expect.element(page.getByRole("link", { name: /Office GRWM/ })).toBeVisible();
    expect(page.getByRole("link", { name: /Quick start/ }).query()).toBeNull();
  });

  it("invites the member to paste a link when there's nothing in it yet", async () => {
    await member();
    await showLibrary();
    await expect.element(page.getByText("0 Shorts")).toBeVisible();
    await expect
      .element(page.getByText("Nothing here yet. Paste a Shorts link above", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Index it" })).toBeDisabled();
  });

  it("says when the library can't be read, and reads it again", async () => {
    await member();
    await commands.failRequests("/rpc/director/library", { status: 502 });
    await showLibrary();
    await expect.element(page.getByRole("alert")).toBeVisible();
    const tried = await commands.failedRequests("/rpc/director/library");
    await userEvent.click(page.getByRole("button", { name: "Try again" }));
    await expect
      .poll(() => commands.failedRequests("/rpc/director/library"))
      .toBeGreaterThan(tried);
  });
});

describe("indexing a short of your own", () => {
  it("follows Director live from the queue to ready, then opens the shots", async () => {
    const orgId = await member();
    const videoId = newVideoId();
    await showLibrary();
    await expect.element(page.getByText("0 Shorts")).toBeVisible();

    await userEvent.fill(link(), `https://www.youtube.com/shorts/${videoId}`);
    await userEvent.click(page.getByRole("button", { name: "Index it" }));
    await expect.element(page.getByRole("status", { name: "Waiting for Gemini" })).toBeVisible();
    await expect.element(page.getByText("1 Short", { exact: true })).toBeVisible();

    const progress = page.getByRole("list", { name: "Indexing progress" });
    for (const [stage, label, step] of [
      ["watching", "Gemini is watching the Short", "Watching"],
      ["writing", "Writing the shot list", "Writing shots"],
    ] as const) {
      await commands.fakeLibrary(orgId, {
        templates: [{ videoId, status: "analyzing", stage, plan: null }],
      });
      await commands.publishRealtime(`org:${orgId}`, { type: "director.changed" });
      await expect.element(page.getByRole("status", { name: label })).toBeVisible();
      await expect
        .element(progress.getByRole("listitem").filter({ hasText: step }))
        .toHaveAttribute("aria-current", "step");
    }

    await commands.fakeLibrary(orgId, {
      templates: [{ ...seed("My own short", videoId), source: "user" }],
      indexUsed: true,
    });
    await commands.publishRealtime(`org:${orgId}`, { type: "director.changed" });
    await expect.element(page.getByText("Ready to shoot")).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "See the shots" }));
    expect(currentUrl()).toBe(`/director/${videoId}`);
  });

  it("refuses a second short with the AI credit used, offering the starters instead", async () => {
    const orgId = await member();
    const grwm = seed("Office GRWM");
    await commands.fakeLibrary(orgId, {
      templates: [{ ...seed("Mine"), source: "user" }, grwm],
      indexUsed: true,
    });
    await showLibrary();
    await expect
      .element(page.getByText("You've added your own Short.", { exact: false }))
      .toBeVisible();

    await userEvent.fill(link(), `https://youtu.be/${newVideoId()}`);
    await userEvent.click(page.getByRole("button", { name: "Index it" }));
    const dialog = page.getByRole("dialog", { name: "You've used your AI credit" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByRole("link", { name: "Office GRWM" }))
      .toHaveAttribute("href", `/director/${grwm.videoId}`);
    // Only the starters: not the member's own.
    expect(dialog.getByRole("link").all()).toHaveLength(1);
    await userEvent.click(dialog.getByRole("button", { name: "Got it" }));
    await expect.element(dialog).not.toBeInTheDocument();
    // Focus goes back to the link field, not to the top of the page.
    await expect.element(link()).toHaveFocus();
    // Nothing was added, and the form is there to paste a link already in the library.
    await expect.element(page.getByText("2 Shorts")).toBeVisible();
    expect(page.getByRole("alert").query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Index it" })).toBeVisible();
  });

  it("opens a short that's already in the library, using up nothing", async () => {
    const orgId = await member();
    const grwm = seed("Office GRWM");
    await commands.fakeLibrary(orgId, { templates: [grwm], indexUsed: true });
    await showLibrary();
    await userEvent.fill(link(), `https://www.youtube.com/watch?v=${grwm.videoId}`);
    await userEvent.click(page.getByRole("button", { name: "Index it" }));
    await expect.poll(currentUrl).toBe(`/director/${grwm.videoId}`);
  });

  it("says why a link can't be indexed", async () => {
    await member();
    await showLibrary();
    await userEvent.fill(link(), "https://example.com/not-youtube");
    await userEvent.click(page.getByRole("button", { name: "Index it" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "That video isn't on YouTube, or it's private. Check the link and try again.",
      );
    await expect.element(page.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("says when the link can't be checked at all", async () => {
    await member();
    await showLibrary();
    await commands.failRequests("/rpc/director/index", { status: 502 });
    await userEvent.fill(link(), `https://youtu.be/${newVideoId()}`);
    await userEvent.click(page.getByRole("button", { name: "Index it" }));
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(await commands.failedRequests("/rpc/director/index")).toBe(1);
  });

  it.each([
    [
      "DIRECTOR_VIDEO_UNREADABLE",
      "Director couldn't watch this short. It may be private, age-restricted or removed.",
    ],
    [null, "Director couldn't work out how to film this short. Try again."],
  ])(
    "says why indexing failed (%s), which didn't count, and takes another link",
    async (error, message) => {
      const orgId = await member();
      const videoId = newVideoId();
      await showLibrary();
      await userEvent.fill(link(), `https://youtu.be/${videoId}`);
      await userEvent.click(page.getByRole("button", { name: "Index it" }));
      await expect.element(page.getByRole("status", { name: "Waiting for Gemini" })).toBeVisible();

      await commands.fakeLibrary(orgId, {
        templates: [
          {
            videoId,
            status: "failed",
            stage: "failed",
            error,
            plan: null,
          },
        ],
        indexUsed: false,
      });
      await commands.publishRealtime(`org:${orgId}`, { type: "director.changed" });
      await expect.element(page.getByRole("alert")).toHaveTextContent(message);
      await userEvent.click(page.getByRole("button", { name: "Try another link" }));
      await expect.element(link()).toHaveValue("");
    },
  );
});
