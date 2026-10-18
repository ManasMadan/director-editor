/**
 * Publishing a cut from My media, against the real API: Gemini's post (the AI stand-in
 * writes it), edited and sent to the member's channel on the mock YouTube, the privacy
 * YouTube actually gave it said honestly, and Google asked for YouTube uploads first when
 * the member hasn't allowed them, picking up where it was on the way back.
 */
import type { DirectorCut } from "@repo/contracts/api";
import {
  directorCutIdSchema,
  directorPlanIdSchema,
  fileIdSchema,
  videoIdSchema,
} from "@repo/contracts/ids";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { MediaPage } from "@/modules/director";
import { PublishButton } from "@/modules/director/components/publish-sheet";
import { cleanup, currentUrl, renderPage } from "../render";
import { auth, currentSession, signUp } from "../users";

const COPY = {
  title: "Three looks, one mirror",
  description: "My take on the trend.",
  hashtags: ["grwm", "fitcheck"],
  credits: "Inspired by the original, recreated with Director.",
};
// An MP4's first box: what the mock YouTube takes is whatever bytes the API streams.
const VIDEO = "AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t";

interface Made {
  cut: DirectorCut;
  user: Awaited<ReturnType<typeof signUp>>;
}

/** Signs the page in as a demo guest (the full API gives them out), as a member is. */
async function asGuest() {
  await auth("/sign-in/guest", {});
  const { user } = await currentSession();
  return { ...user, password: "" };
}

/**
 * A member's cut of one of their workspace's seeded templates: in the database (where
 * the API records its publishing), as the AI stand-in answers it, and its video in
 * storage unless `stored` is false.
 */
async function aCut({ stored = true, copy = true, guest = false } = {}): Promise<Made> {
  const user = guest ? await asGuest() : await signUp();
  const { session } = await currentSession();
  const [plan] = await commands.sql<{ id: string; video_id: string }>(
    "SELECT id, video_id FROM ai.director_plan WHERE org_id = $1 LIMIT 1",
    [session.activeOrganizationId],
  );
  const [file] = await commands.sql<{ id: string }>(
    `INSERT INTO files.file (user_id, purpose, status, filename, declared_type, declared_size,
                             content_type, size, ready_at, updated_at)
     VALUES ($1, 'director-cut-video', 'ready', 'cut.mp4', 'video/mp4', 24, 'video/mp4', 24,
             now(), now()) RETURNING id`,
    [user.id],
  );
  if (stored) {
    await commands.storeFile(`files/${file?.id}`, VIDEO, "video/mp4");
  }
  const [row] = await commands.sql<{ id: string }>(
    `INSERT INTO ai.director_cut (org_id, plan_id, user_id, title, picks, file_id, duration_ms, updated_at)
     VALUES ($1, $2, $3, 'My look', '[]', $4, 4000, now()) RETURNING id`,
    [session.activeOrganizationId, plan?.id, user.id, file?.id],
  );
  const cut: DirectorCut = {
    id: directorCutIdSchema.parse(row?.id),
    planId: directorPlanIdSchema.parse(plan?.id),
    videoId: videoIdSchema.parse(plan?.video_id),
    templateTitle: "Get ready with me",
    title: "My look",
    picks: {},
    fileId: fileIdSchema.parse(file?.id),
    durationMs: 4000,
    createdAt: new Date(),
    publish: { status: "none", youtubeVideoId: null, visibility: null },
  };
  await commands.fakeCut(cut.id, {
    cut: {
      ...cut,
      picks: [],
      publishStatus: "none",
      youtubeVideoId: null,
      visibility: null,
      createdAt: cut.createdAt.toISOString(),
    },
    ...(copy && { copy: COPY }),
  });
  return { cut, user };
}

/** The button as a card in My media holds it, with the card's heading to fall back on. */
function Card({ cut }: { cut: DirectorCut }) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h3 ref={heading} tabIndex={-1}>
        {cut.title}
      </h3>
      <PublishButton cut={cut} heading={heading} />
    </>
  );
}

const open = async (cut: DirectorCut, url = "/media") => {
  const view = await renderPage(<Card cut={cut} />, { url });
  if (!url.includes("publish=")) {
    await userEvent.click(view.getByRole("button", { name: "Publish", exact: true }));
  }
  return view;
};

const publishButton = () => page.getByRole("button", { name: "Publish to YouTube" });

describe("publishing a cut", { tags: ["files"] }, () => {
  // Each test may publish: the day's allowance starts afresh for each.
  beforeEach(() => commands.resetPublishAllowance());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A cut of the member's, allowed on YouTube, in My media, which is open on it. */
  async function inMyMedia() {
    const made = await aCut();
    await commands.linkYouTube(made.user.id, made.user.email);
    // The cut in My media's list too, as the AI service lists the member's cuts.
    await commands.fakeDirector(made.cut.videoId, {
      cuts: [
        {
          ...made.cut,
          picks: [],
          publishStatus: "none",
          youtubeVideoId: null,
          visibility: null,
          createdAt: made.cut.createdAt.toISOString(),
          userId: made.user.id,
        },
      ],
    });
    await renderPage(<MediaPage />, { url: "/media" });
    return made;
  }

  it("keeps saying how it went while My media catches up with the cut", async () => {
    await inMyMedia();
    await userEvent.click(page.getByRole("button", { name: "Publish", exact: true }));
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await userEvent.click(page.getByRole("button", { name: "Public" }));
    const listed = await commands.answeredRequests("director/media");
    await userEvent.click(publishButton());
    const published = page.getByText("It's on YouTube, private: only you can watch it.");
    await expect.element(published).toBeVisible();
    // My media read the list again, the cut published in it now: the sheet still says so.
    await expect.poll(() => commands.answeredRequests("director/media")).toBeGreaterThan(listed);
    await expect.element(page.getByText("Private on YouTube")).toBeInTheDocument();
    await expect.element(published).toBeVisible();
    await expect
      .element(page.getByText("You asked for public, but YouTube keeps", { exact: false }))
      .toBeVisible();
    // Closed: focus goes to what stands for the publish on the card now, the link.
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("link", { name: "Watch on YouTube" })).toHaveFocus();
  });

  it("puts focus on the card's title when the sheet closes on a publish under way", async () => {
    const { cut } = await inMyMedia();
    await userEvent.click(page.getByRole("button", { name: "Publish", exact: true }));
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    // Another tab started publishing it a moment ago.
    await commands.sql("UPDATE ai.director_cut SET publish_status = 'uploading' WHERE id = $1", [
      cut.id,
    ]);
    const listed = await commands.answeredRequests("director/media");
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("This video is already on its way to YouTube.", { exact: false }))
      .toBeVisible();
    await expect.poll(() => commands.answeredRequests("director/media")).toBeGreaterThan(listed);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("heading", { name: cut.title })).toHaveFocus();
  });

  it("drops ?publish once it has opened, so a reload neither opens it nor asks Gemini again", async () => {
    const { cut } = await aCut();
    await open(cut, `/media?publish=${cut.id}`);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await expect.poll(currentUrl).toBe("/media");
    const asked = await commands.answeredRequests("publish/copy");
    // Reloaded: the address has no ?publish any more.
    cleanup();
    await renderPage(<Card cut={cut} />, { url: currentUrl() });
    await expect.element(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    expect(page.getByLabelText("Title").query()).toBeNull();
    expect(await commands.answeredRequests("publish/copy")).toBe(asked);
  });

  it("goes back to the Publish button when the sheet closes unpublished", async () => {
    const { cut } = await aCut();
    await open(cut);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Publish", exact: true })).toHaveFocus();
  });

  it("publishes Gemini's post as the member edited it, and says YouTube kept it private", async () => {
    const { cut, user } = await aCut();
    await commands.linkYouTube(user.id, user.email);
    await open(cut);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await expect.element(page.getByLabelText("Hashtags")).toHaveValue("#grwm #fitcheck");
    await expect.element(page.getByLabelText("Your video: My look")).toBeVisible();
    await userEvent.fill(page.getByLabelText("Title"), "Mirror, mirror");
    await expect
      .element(page.getByText("YouTube shows it as “Mirror, mirror #Shorts”."))
      .toBeVisible();
    await userEvent.fill(page.getByLabelText("Hashtags"), "grwm ootd");
    await userEvent.click(page.getByRole("button", { name: "Public" }));
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("It's on YouTube, private: only you can watch it."))
      .toBeVisible();
    await expect
      .element(page.getByText("You asked for public, but YouTube keeps", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Watch on YouTube" }))
      .toHaveAttribute(
        "href",
        expect.stringMatching(/^https:\/\/youtube\.com\/shorts\/[\w-]{11}$/),
      );
    const [stored] = await commands.sql<{ publish_status: string; visibility: string }>(
      "SELECT publish_status, visibility FROM ai.director_cut WHERE id = $1",
      [cut.id],
    );
    expect(stored).toEqual({ publish_status: "published", visibility: "private" });
  });

  it("says nothing more when YouTube gave it the privacy asked for", async () => {
    const { cut, user } = await aCut();
    await commands.linkYouTube(user.id, user.email);
    await open(cut);
    await userEvent.click(page.getByRole("button", { name: "Private" }));
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("It's on YouTube, private: only you can watch it."))
      .toBeVisible();
    await expect.element(page.getByText("You asked for", { exact: false })).not.toBeInTheDocument();
  });

  it("asks Google to allow YouTube uploads, then publishes what was kept on the way back", async () => {
    const { cut } = await aCut();
    await open(cut);
    await userEvent.fill(page.getByLabelText("Title"), "Kept for later");
    await userEvent.click(publishButton());
    await expect
      .poll(async () => (await commands.hardNavigations())[0])
      .toMatch(/^https:\/\/accounts\.google\.com\/.*youtube\.upload/);
    expect(sessionStorage.getItem(`director.publish.${cut.id}`)).toContain("Kept for later");

    // Back from Google: still not allowed (the stand-in Google consents to nothing), so
    // it says so rather than going round again.
    cleanup();
    await open(cut, `/media?publish=${cut.id}`);
    await expect
      .element(page.getByText("Director needs your permission to upload to your YouTube channel."))
      .toBeVisible();
    expect(await commands.hardNavigations()).toHaveLength(1);
    expect(sessionStorage.getItem(`director.publish.${cut.id}`)).toBeNull();
    await expect.element(page.getByLabelText("Title")).toHaveValue("Kept for later");

    // Closed and opened again: Director's post, and nothing sent until the member says so.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Publish", exact: true }));
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await expect
      .element(page.getByText("Director needs your permission", { exact: false }))
      .not.toBeInTheDocument();
  });

  it("still asks Google when there's nowhere to keep the draft", async () => {
    const { cut } = await aCut();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await open(cut);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    await userEvent.click(publishButton());
    await expect
      .poll(async () => (await commands.hardNavigations())[0])
      .toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it("opens with Director's post when what was kept can't be read", async () => {
    const { cut } = await aCut();
    sessionStorage.setItem(`director.publish.${cut.id}`, "{not json");
    await open(cut, `/media?publish=${cut.id}`);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    expect(sessionStorage.getItem(`director.publish.${cut.id}`)).toBeNull();
  });

  it("checks a long post against YouTube's limit in bytes, as the API will", async () => {
    const { cut } = await aCut();
    await open(cut);
    await expect.element(page.getByLabelText("Title")).toHaveValue(COPY.title);
    // Within the length limit, but three bytes a character.
    await userEvent.fill(page.getByLabelText("Description"), "あ".repeat(1_700));
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("YouTube won't take this as it is.", { exact: false }))
      .toBeVisible();
  });

  it("lets the member write the post when Gemini can't, and checks it first", async () => {
    // Opened straight from the link, with nothing kept for it.
    const { cut } = await aCut({ stored: false, copy: false });
    // Its upload isn't checked yet, so there's no link to its video.
    await commands.sql("UPDATE files.file SET status = 'pending' WHERE id = $1", [cut.fileId]);
    await open(cut, `/media?publish=${cut.id}`);
    await expect
      .element(page.getByText("Director couldn't write a post this time.", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByLabelText("Title")).toHaveValue("My look");
    // No video to show: its upload isn't in storage.
    await expect.element(page.getByLabelText("Your video: My look")).not.toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Description"), "a <b>bold</b> claim");
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("YouTube won't take this as it is.", { exact: false }))
      .toBeVisible();
  });

  it("says when another publish of it is already under way", async () => {
    const { cut, user } = await aCut();
    await commands.linkYouTube(user.id, user.email);
    await open(cut);
    // Another tab started publishing it a moment ago.
    await commands.sql("UPDATE ai.director_cut SET publish_status = 'uploading' WHERE id = $1", [
      cut.id,
    ]);
    await userEvent.click(publishButton());
    await expect
      .element(page.getByText("This video is already on its way to YouTube.", { exact: false }))
      .toBeVisible();
  });

  it("offers nothing while it's on its way, or published with nowhere to link", async () => {
    const { cut } = await aCut({ stored: false });
    for (const publish of [
      { status: "uploading" as const, youtubeVideoId: null, visibility: null },
      { status: "published" as const, youtubeVideoId: null, visibility: null },
    ]) {
      cleanup();
      const view = await renderPage(<Card cut={{ ...cut, publish }} />);
      expect(view.getByRole("button").query(), publish.status).toBeNull();
      expect(view.getByRole("link").query(), publish.status).toBeNull();
    }
  });

  it("shows the demo the post Director wrote, to read, with posting off", async () => {
    const { cut } = await aCut({ stored: false, guest: true });
    const view = await renderPage(<Card cut={cut} />);
    const see = view.getByRole("button", { name: "See the post Director wrote" });
    await expect.element(see).toBeVisible();
    await userEvent.click(see);
    const sheet = page.getByRole("dialog", { name: "The post Director wrote" });
    await expect
      .element(
        sheet.getByText("Posting is off for the demo. Sign in with Google to post your own."),
      )
      .toBeVisible();
    await expect.element(sheet.getByText(COPY.title)).toBeVisible();
    await expect.element(sheet.getByText(COPY.description)).toBeVisible();
    await expect.element(sheet.getByText("#grwm #fitcheck")).toBeVisible();
    await expect.element(sheet.getByText(COPY.credits)).toBeVisible();
    expect(publishButton().query()).toBeNull();
    expect(sheet.getByRole("textbox").query()).toBeNull();
  });

  it("tells the demo when Director couldn't write the post", async () => {
    const { cut } = await aCut({ stored: false, guest: true, copy: false });
    const view = await renderPage(<Card cut={cut} />);
    const see = view.getByRole("button", { name: "See the post Director wrote" });
    await expect.element(see).toBeVisible();
    await userEvent.click(see);
    await expect.element(page.getByText("Director couldn't write a post this time.")).toBeVisible();
    expect(publishButton().query()).toBeNull();
  });

  it("links a published cut to YouTube instead", async () => {
    const { cut } = await aCut({ stored: false });
    await renderPage(
      <Card
        cut={{
          ...cut,
          publish: { status: "published", youtubeVideoId: "AbCdEfGhIjK", visibility: "unlisted" },
        }}
      />,
    );
    await expect
      .element(page.getByRole("link", { name: "Watch on YouTube" }))
      .toHaveAttribute("href", "https://youtube.com/shorts/AbCdEfGhIjK");
  });
});
