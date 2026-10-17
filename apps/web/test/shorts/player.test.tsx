import type { Short, ShortComment } from "@repo/contracts/api";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ShortsPlayerPage } from "@/modules/shorts";
import { currentUrl, renderPage } from "../render";
import { api, signUp } from "../users";
import { editShorts, type Feed } from "./support";

const PEN = { videoId: "kJQP7kiw5Fk", title: "Dropped my pen… had to check the kicks" };
const GRWM = { videoId: "HasaZYkwYds", title: "GRWM for the office in summer time!" };

const slideTitles = () =>
  [...document.querySelectorAll("section[aria-label]")]
    .map((slide) => slide.getAttribute("aria-label"))
    .filter((label) => !label?.startsWith("Notifications"));

/** The YouTube player on screen, once it's there. */
async function playerOf(title: string) {
  await expect
    .poll(() => document.querySelector(`iframe[title="${title} on YouTube"]`))
    .toBeTruthy();
  return document.querySelector(`iframe[title="${title} on YouTube"]`) as HTMLIFrameElement;
}

/** Brings a slide on screen, as a swipe does. */
function swipeTo(title: string) {
  document.querySelector(`section[aria-label="${title}"]`)?.scrollIntoView();
}

/** Sets `navigator.share` for the test (undefined: a browser without it). */
function share(value: Navigator["share"] | undefined) {
  Object.defineProperty(navigator, "share", { value, configurable: true });
  onTestFinished(() => {
    delete (navigator as { share?: unknown }).share;
  });
}

describe("the Shorts player", () => {
  it("plays the short asked for first, then the feed without it again", async () => {
    await signUp();
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    const player = await playerOf(PEN.title);
    const src = new URL(player.src);
    expect(src.origin + src.pathname).toBe(`https://www.youtube-nocookie.com/embed/${PEN.videoId}`);
    expect(Object.fromEntries(src.searchParams)).toMatchObject({
      autoplay: "1",
      mute: "1",
      loop: "1",
    });
    await expect.poll(slideTitles).toHaveLength(6);
    const titles = slideTitles();
    expect(titles[0]).toBe(PEN.title);
    expect(titles.filter((title) => title === PEN.title)).toHaveLength(1);
    const slide = page.getByRole("region", { name: PEN.title });
    await expect.element(slide.getByText("@Director demo")).toBeVisible();
    await expect.element(slide.getByRole("button", { name: "Like" })).toHaveTextContent("240K");
    await expect.element(slide.getByRole("button", { name: "Comments" })).toHaveTextContent("3.9K");
    await expect
      .element(slide.getByRole("link", { name: "Director" }))
      .toHaveAttribute("href", `/director/${PEN.videoId}`);
    await expect
      .element(page.getByRole("link", { name: "Home", exact: true }).first())
      .toHaveAttribute("href", "/library");
    await expect
      .element(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Shorts" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("starts at the top of the feed, the address following the short on screen", async () => {
    await signUp();
    await renderPage(<ShortsPlayerPage />, { url: "/shorts" });
    await playerOf(GRWM.title);
    expect(slideTitles()[0]).toBe(GRWM.title);
    await expect.poll(currentUrl).toBe(`/shorts/${GRWM.videoId}`);
    swipeTo(PEN.title);
    await playerOf(PEN.title);
    await expect.poll(currentUrl).toBe(`/shorts/${PEN.videoId}`);
    // The short swiped away stops: its picture shows instead of its player.
    expect(document.querySelector(`iframe[title="${GRWM.title} on YouTube"]`)).toBeNull();
  });

  it("loads the next page of the feed on reaching its last short", async () => {
    await signUp();
    editShorts<Feed>("feed", (feed, input) =>
      input.pageToken === "page-2"
        ? { items: feed.items.slice(2, 4), nextPageToken: null }
        : { items: feed.items.slice(0, 2), nextPageToken: "page-2" },
    );
    await renderPage(<ShortsPlayerPage />, { url: "/shorts" });
    await playerOf(GRWM.title);
    expect(slideTitles()).toEqual([GRWM.title, PEN.title]);
    swipeTo(PEN.title);
    await expect.poll(() => slideTitles().length).toBe(4);
    // The last page has no next one: reaching its end asks for nothing more.
    const last = slideTitles()[3] as string;
    swipeTo(last);
    await playerOf(last);
    expect(await commands.answeredRequests("/rpc/shorts/feed")).toBe(2);
  });

  it("waits for shorts while the feed has none", async () => {
    await signUp();
    editShorts<Feed>("feed", (feed) => ({ ...feed, items: [] }));
    const page = await renderPage(<ShortsPlayerPage />, { url: "/shorts" });
    await expect.poll(() => commands.answeredRequests("/rpc/shorts/feed")).toBe(1);
    await expect.element(page.getByRole("status", { name: "Loading" })).toBeVisible();
    expect(slideTitles()).toEqual([]);
  });

  it("says why the short didn't load", async () => {
    await signUp();
    await commands.failRequests("/rpc/shorts/get");
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });

  it("unmutes and mutes the player, which comes back muted", async () => {
    await signUp();
    const page = await renderPage(<ShortsPlayerPage />, { url: "/shorts" });
    const player = await playerOf(GRWM.title);
    const post = vi.spyOn(player.contentWindow as Window, "postMessage");
    const slide = page.getByRole("region", { name: GRWM.title });
    await userEvent.click(slide.getByRole("button", { name: "Unmute" }));
    expect(post).toHaveBeenLastCalledWith(
      JSON.stringify({ event: "command", func: "unMute", args: [] }),
      "https://www.youtube-nocookie.com",
    );
    await userEvent.click(slide.getByRole("button", { name: "Mute" }));
    expect(post).toHaveBeenLastCalledWith(
      JSON.stringify({ event: "command", func: "mute", args: [] }),
      "https://www.youtube-nocookie.com",
    );
    await userEvent.click(slide.getByRole("button", { name: "Unmute" }));
    await expect.element(slide.getByRole("button", { name: "Mute" })).toBeVisible();
    swipeTo(PEN.title);
    await playerOf(PEN.title);
    await expect.element(slide.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
  });

  it("likes and saves the short, and takes it back", async () => {
    await signUp();
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    const slide = page.getByRole("region", { name: PEN.title });
    const like = slide.getByRole("button", { name: "Like" });
    const save = slide.getByRole("button", { name: "Save" });
    await expect.element(like).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(like);
    await expect.element(like).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(save);
    await expect.element(save).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => api.shorts.reactions({ videoId: PEN.videoId }))
      .toEqual({ liked: true, saved: true });
    await userEvent.click(like);
    await expect.element(like).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(() => api.shorts.reactions({ videoId: PEN.videoId }))
      .toEqual({ liked: false, saved: true });
  });

  it("names the buttons when YouTube hides the counts", async () => {
    await signUp();
    editShorts<Short>("get", (short) => ({ ...short, likeCount: null, commentCount: null }));
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    const slide = page.getByRole("region", { name: PEN.title });
    await expect.element(slide.getByRole("button", { name: "Like" })).toHaveTextContent("Like");
    await expect
      .element(slide.getByRole("button", { name: "Comments" }))
      .toHaveTextContent("Comments");
  });

  it("shares the short with the browser's share sheet", async () => {
    await signUp();
    const sheet = vi.fn<Navigator["share"]>().mockResolvedValue(undefined);
    share(sheet);
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    const button = page
      .getByRole("region", { name: PEN.title })
      .getByRole("button", { name: "Share" });
    await userEvent.click(button);
    expect(sheet).toHaveBeenCalledWith({
      title: PEN.title,
      url: `https://www.youtube.com/shorts/${PEN.videoId}`,
    });
    // Closing the sheet without sharing is no error.
    sheet.mockRejectedValue(new DOMException("Share canceled", "AbortError"));
    await userEvent.click(button);
    expect(sheet).toHaveBeenCalledTimes(2);
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it("copies the short's link where the browser can't share", async () => {
    await signUp();
    share(undefined);
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    onTestFinished(() => copy.mockRestore());
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    const button = page
      .getByRole("region", { name: PEN.title })
      .getByRole("button", { name: "Share" });
    await userEvent.click(button);
    expect(copy).toHaveBeenCalledWith(`https://www.youtube.com/shorts/${PEN.videoId}`);
    await expect.element(page.getByText("Link copied")).toBeVisible();
  });

  it("says nothing when the link couldn't be copied", async () => {
    await signUp();
    share(undefined);
    const copy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    onTestFinished(() => copy.mockRestore());
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    await userEvent.click(
      page.getByRole("region", { name: PEN.title }).getByRole("button", { name: "Share" }),
    );
    await expect.poll(() => copy.mock.calls.length).toBe(1);
    expect(page.getByText("Link copied").query()).toBeNull();
  });

  it("shows the short's top comments, and where to add one", async () => {
    await signUp();
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    await userEvent.click(
      page.getByRole("region", { name: PEN.title }).getByRole("button", { name: "Comments" }),
    );
    const dialog = page.getByRole("dialog", { name: "Comments" });
    await expect
      .element(dialog.getByText("Trying this tonight, the steps are so clear."))
      .toBeVisible();
    await expect.element(dialog.getByText(/^@viewer1/)).toBeVisible();
    await expect.element(dialog.getByText("6K", { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByRole("link", { name: "Comment on YouTube" }))
      .toHaveAttribute("href", `https://www.youtube.com/shorts/${PEN.videoId}`);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it.each([
    [true, "Comments are turned off for this short."],
    [false, "No comments yet."],
  ])("says when there are no comments to show (turned off: %s)", async (disabled, message) => {
    await signUp();
    editShorts<{ items: ShortComment[]; disabled: boolean }>("comments", () => ({
      items: [],
      disabled,
    }));
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    await userEvent.click(
      page.getByRole("region", { name: PEN.title }).getByRole("button", { name: "Comments" }),
    );
    await expect.element(page.getByRole("dialog").getByText(message)).toBeVisible();
  });

  it("says why the comments didn't load", async () => {
    await signUp();
    await commands.failRequests("/rpc/shorts/comments");
    const page = await renderPage(<ShortsPlayerPage videoId={PEN.videoId} />, {
      url: `/shorts/${PEN.videoId}`,
    });
    await userEvent.click(
      page.getByRole("region", { name: PEN.title }).getByRole("button", { name: "Comments" }),
    );
    await expect
      .element(page.getByRole("dialog").getByRole("alert"))
      .toHaveTextContent("We can't reach the server. Check your connection and try again.");
  });
});
