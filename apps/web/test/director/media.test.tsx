/** My media: the member's saved videos, under the template each was made from. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { MediaPage } from "@/modules/director";
import { renderPage } from "../render";
import { signUp } from "../users";
import { newVideoId } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A saved cut as the AI stand-in lists it: the caller's (`userId`) unless said otherwise. */
function cut(
  userId: string,
  videoId: string,
  overrides: {
    title?: string;
    templateTitle?: string;
    publishStatus?: string;
    visibility?: string | null;
    createdAt?: string;
  } = {},
) {
  return {
    id: crypto.randomUUID(),
    planId: crypto.randomUUID(),
    videoId,
    templateTitle: "Morning routine",
    title: "My morning",
    picks: [{ shotIndex: 0, takeId: crypto.randomUUID() }],
    fileId: crypto.randomUUID(),
    durationMs: 12_000,
    createdAt: new Date("2026-10-18T10:00:00Z").toISOString(),
    publishStatus: "none",
    youtubeVideoId: null,
    visibility: null,
    userId,
    ...overrides,
  };
}

const openMedia = () => renderPage(<MediaPage />, { url: "/media" });

describe("My media", () => {
  it("invites the member to make their first video", async () => {
    await signUp();
    const page = await openMedia();
    await expect.element(page.getByRole("heading", { name: "My media" })).toBeVisible();
    await expect.element(page.getByText("Nothing saved yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Pick a Short" }))
      .toHaveAttribute("href", "/library");
    await expect
      .element(page.getByRole("link", { name: "Back to the library" }))
      .toHaveAttribute("href", "/library");
  });

  it("groups the videos by template, newest first, each with where its publishing stands", async () => {
    const user = await signUp();
    const [morning, dance] = [newVideoId(), newVideoId()];
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 18, hour)).toISOString();
    await commands.fakeDirector(morning, {
      cuts: [
        cut(user.id, morning, { title: "Take two", createdAt: at(12), publishStatus: "uploading" }),
        cut(user.id, morning, {
          title: "Public one",
          createdAt: at(11),
          publishStatus: "published",
          visibility: "public",
        }),
        cut(user.id, morning, {
          title: "Unlisted one",
          createdAt: at(10),
          publishStatus: "published",
          visibility: "unlisted",
        }),
        cut(user.id, morning, {
          title: "Private one",
          createdAt: at(9),
          publishStatus: "published",
          visibility: "private",
        }),
        cut(user.id, morning, { title: "Somewhere", createdAt: at(8), publishStatus: "published" }),
        // Someone else's: not in this member's media.
        cut(crypto.randomUUID(), morning, { title: "Not mine", createdAt: at(14) }),
      ],
    });
    await commands.fakeDirector(dance, {
      cuts: [
        cut(user.id, dance, {
          title: "Dance off",
          templateTitle: "Dance challenge",
          createdAt: at(13),
          publishStatus: "failed",
        }),
      ],
    });
    const page = await openMedia();

    const headings = page.getByRole("heading", { level: 2 });
    await expect.element(headings.first()).toHaveTextContent("Dance challenge");
    expect(headings.elements().map((heading) => heading.textContent)).toEqual([
      "Dance challenge",
      "Morning routine",
    ]);
    await expect.element(page.getByText("5 videos")).toBeVisible();
    await expect.element(page.getByText("1 video", { exact: true })).toBeVisible();
    expect(page.getByText("Not mine").query()).toBeNull();

    const card = (title: string) =>
      page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) });
    await expect.element(card("Dance off").getByText("Couldn't publish")).toBeVisible();
    await expect.element(card("Take two").getByText("Publishing…")).toBeVisible();
    await expect.element(card("Public one").getByText("Public on YouTube")).toBeVisible();
    await expect.element(card("Unlisted one").getByText("Unlisted on YouTube")).toBeVisible();
    await expect.element(card("Private one").getByText("Private on YouTube")).toBeVisible();
    await expect.element(card("Somewhere").getByText("On YouTube", { exact: true })).toBeVisible();
    await expect.element(card("Take two").getByText("00:12")).toBeVisible();
    await expect.element(card("Take two").getByText("Oct 18, 2026")).toBeVisible();
    // The template's own thumbnail beside its name.
    const thumbnail = document.querySelector(`img[src*="/vi/${morning}/"]`);
    expect(thumbnail?.getAttribute("src")).toBe(`https://i.ytimg.com/vi/${morning}/hqdefault.jpg`);
  });

  it("says when a video can't be opened", async () => {
    const user = await signUp();
    const videoId = newVideoId();
    // A file that isn't in storage.
    await commands.fakeDirector(videoId, { cuts: [cut(user.id, videoId)] });
    const page = await openMedia();
    await userEvent.click(page.getByRole("button", { name: "Play My morning" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This video couldn't be opened. Try again.");
  });

  it("shimmers while the videos load, and says when they can't be", async () => {
    await signUp();
    await commands.failRequests("/rpc/director/media", { status: 502 });
    const page = await openMedia();
    await expect.element(page.getByRole("status", { name: "Loading your videos…" })).toBeVisible();
    await expect.element(page.getByRole("alert"), { timeout: 10_000 }).toBeVisible();
  });
});
