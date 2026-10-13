/**
 * The editor: the member's takes (downloaded from storage) on a timeline, Director's
 * review of each, the edit's choices, and the short put together in the browser.
 */
import { uploadFile } from "@repo/client/api/files/upload";
import type { UploadPurpose } from "@repo/contracts/files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { ReviewPage } from "@/modules/director";
import { currentUrl, renderPage } from "../render";
import { api, signUp } from "../users";
import { newVideoId, photo, planShot, readyPlan, recordVideo, shotPlan, take } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A take's file, uploaded and checked as the worker would. */
async function uploaded(purpose: UploadPurpose, blob: Blob) {
  const file = new File([blob], `take.${blob.type === "image/jpeg" ? "jpg" : "webm"}`, {
    type: blob.type,
  });
  const { id } = await uploadFile(api, purpose, file);
  await commands.checkUpload(id);
  return id;
}

async function openEditor(videoId: string, audio: string | undefined) {
  return renderPage(<ReviewPage videoId={videoId} audio={audio} />, {
    url: `/director/${videoId}/review`,
  });
}

/** The editor's clock: the time, then the edit's length. */
const clock = () => document.querySelector("p.font-mono")?.firstChild?.textContent;

/** Recording only WebM, as Firefox does. */
function webmOnly() {
  const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
  vi.spyOn(MediaRecorder, "isTypeSupported").mockImplementation(
    (type) => !type.startsWith("video/mp4") && supported(type),
  );
}

describe("the editor before it can open", () => {
  it("waits for the plan, and says when there isn't one", async () => {
    await signUp();
    const pending = newVideoId();
    await commands.fakeDirector(pending, { plan: { status: "analyzing", plan: null } });
    const page = await openEditor(pending, "voice");
    await expect.element(page.getByRole("status")).toBeVisible();
    expect(page.getByRole("link", { name: "Back" }).query()).toBeNull();
  });

  it("leads back when Director hasn't planned the short", async () => {
    await signUp();
    const videoId = newVideoId();
    const page = await openEditor(videoId, undefined);
    await expect.element(page.getByText("Director is getting ready…")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/director/${videoId}`);
  });

  it("says when the takes can't be read", async () => {
    await signUp();
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan());
    await commands.failRequests("/rpc/director/takes", { status: 502 });
    const page = await openEditor(videoId, "voice");
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(page.getByRole("button", { name: "Next" }).query()).toBeNull();
  });
});

// Takes are downloaded from RustFS: the files profile (`bun run test:integration:files`).
describe("the editor", { tags: ["files"] }, () => {
  it("plays the edit, opens each clip and tool, undoes, and sends the member to film what's left", async () => {
    await commands.storageCors();
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({
        shots: [
          planShot({
            title: "Walk in",
            script: [
              { startSeconds: 0, endSeconds: 1, text: "Morning." },
              { startSeconds: 1, endSeconds: 2, text: "Coffee first." },
            ],
          }),
          planShot({ kind: "photo", title: "Smile", durationSeconds: 1 }),
          planShot({ title: "Wave", durationSeconds: 1 }),
        ],
      }),
    );
    const [video, picture] = await Promise.all([recordVideo(2.5), photo()]);
    await commands.fakeDirector(videoId, {
      takes: [
        take({
          fileId: await uploaded("director-take-video", video),
          score: 82,
          feedback: "Lovely light, keep the smile.",
          bestStartMs: 200,
          bestEndMs: 1800,
        }),
        take({
          fileId: await uploaded("director-take-photo", picture),
          shotIndex: 1,
          kind: "photo",
        }),
      ],
    });
    const page = await openEditor(videoId, "voice");

    await expect.element(page.getByRole("heading", { name: "Morning routine" })).toBeVisible();
    await expect.element(page.getByText("720p")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // One shot still to film: the short can't be made yet.
    await expect.element(page.getByText("1 shot still to film.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Next" })).toBeDisabled();
    // The clip under the playhead, with Director's review.
    await expect.element(page.getByText("Lovely light, keep the smile.")).toBeVisible();
    await expect.element(page.getByText("82/100")).toBeVisible();
    await expect.element(page.getByText("Keeps 0.2 s to 1.8 s")).toBeVisible();
    // The takes' frames on the timeline, once downloaded.
    await expect
      .poll(() =>
        page.getByRole("button", { name: "Shot 1 · Walk in" }).element().querySelector("img"),
      )
      .not.toBeNull();
    expect(clock()).toBe("00:00");

    // Playing, then pausing.
    await userEvent.click(page.getByRole("button", { name: "Play" }));
    await expect.poll(clock).toBe("00:01");
    await userEvent.click(page.getByRole("button", { name: "Pause" }));
    await expect.element(page.getByRole("button", { name: "Play" })).toBeVisible();

    // A clip tapped on the timeline: the clock goes to it, and the panel shows it.
    const smile = page.getByRole("button", { name: "Shot 2 · Smile" });
    await userEvent.click(smile);
    await expect.element(smile).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Shot 2 · Smile", { exact: true }).last()).toBeVisible();
    expect(clock()).toBe("00:01");

    // The caption style, undone and redone.
    const undo = page.getByRole("button", { name: "Undo" });
    const redo = page.getByRole("button", { name: "Redo" });
    await expect.element(undo).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Captions" }));
    await userEvent.click(page.getByRole("button", { name: "Classic" }));
    await expect
      .element(page.getByRole("button", { name: "Classic" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(undo);
    await expect
      .element(page.getByRole("button", { name: "Pop" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(redo).toBeEnabled();
    await userEvent.click(redo);
    await expect
      .element(page.getByRole("button", { name: "Classic" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(page.getByText("1 shot still to film.").query()).toBeNull();

    // A caption's words, changed from the timeline.
    await userEvent.click(page.getByRole("button", { name: "Text" }));
    await expect
      .element(page.getByText("Tap a caption on the timeline to change its words."))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Coffee first." }));
    const words = page.getByRole("textbox", { name: "Caption text" });
    await expect.element(words).toHaveValue("Coffee first.");
    expect(clock()).toBe("00:00");
    await userEvent.fill(words, "Tea first.");
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await expect.element(page.getByRole("button", { name: "Tea first." })).toBeVisible();

    // The member's voice, taken out.
    await userEvent.click(page.getByRole("button", { name: "Sound" }));
    await expect.element(page.getByText("Your voice")).toBeVisible();
    await userEvent.click(page.getByRole("switch", { name: "Keep your voice in the short" }));
    await expect.element(page.getByText("Sound off")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Sound" }));

    // Scrolling the timeline scrubs to the shot still to film, which the panel offers.
    const scroller = page.getByRole("region", { name: "Timeline" }).element()
      .firstElementChild as HTMLElement;
    scroller.scrollLeft = 64 * 3;
    await expect.poll(clock).toBe("00:03");
    await expect.element(page.getByText("Not filmed yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Film it" }))
      .toHaveAttribute("href", `/director/${videoId}/shoot?shot=2&audio=voice`);
    await userEvent.click(page.getByRole("button", { name: "Retake" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=2&audio=voice`);
  });

  it("puts the short together, silent when it was filmed to the original, to download", async () => {
    await commands.storageCors();
    webmOnly();
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({
        audio: "music",
        shots: [
          planShot({
            title: "Walk in",
            durationSeconds: 1,
            script: [{ startSeconds: 0, endSeconds: 1, text: "Hi" }],
          }),
          planShot({ kind: "photo", title: "Smile", durationSeconds: 0.5 }),
        ],
      }),
    );
    const [video, picture] = await Promise.all([recordVideo(1.5), photo()]);
    await commands.fakeDirector(videoId, {
      takes: [
        take({
          fileId: await uploaded("director-take-video", video),
          bestStartMs: 100,
          bestEndMs: 900,
        }),
        take({
          fileId: await uploaded("director-take-photo", picture),
          shotIndex: 1,
          kind: "photo",
        }),
      ],
    });
    const page = await openEditor(videoId, undefined);
    // Filmed to the original: the takes have no sound of their own to keep.
    await expect.element(page.getByText("Original sound · add it on YouTube")).toBeVisible();
    const next = page.getByRole("button", { name: "Next" });
    await expect.element(next).toBeEnabled();
    await userEvent.click(next);
    await expect
      .element(page.getByText("Putting your short together…", { exact: false }))
      .toBeVisible();
    await expect.element(next).toBeDisabled();

    await expect
      .element(page.getByRole("heading", { name: "Your short is ready" }), { timeout: 20_000 })
      .toBeVisible();
    await expect.element(page.getByText("It's silent on purpose", { exact: false })).toBeVisible();
    const download = page.getByRole("link", { name: "Download" });
    await expect.element(download).toHaveAttribute("download", "director-short.webm");
    await expect.element(download).toHaveAttribute("href", expect.stringMatching(/^blob:/));
    expect(document.querySelector("video[controls] track")?.getAttribute("src")).toMatch(/^blob:/);

    await userEvent.click(page.getByRole("button", { name: "Back to editing" }));
    await expect
      .element(page.getByRole("heading", { name: "Your short is ready" }))
      .not.toBeInTheDocument();
    await expect.element(next).toBeEnabled();
  });

  it("keeps the member's voice in an MP4, where the browser records one", async () => {
    await commands.storageCors();
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [planShot({ kind: "photo", title: "Smile", durationSeconds: 0.5 })] }),
    );
    await commands.fakeDirector(videoId, {
      takes: [
        take({ fileId: await uploaded("director-take-photo", await photo()), kind: "photo" }),
      ],
    });
    const page = await openEditor(videoId, "voice");
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await expect
      .element(page.getByRole("link", { name: "Download" }), { timeout: 20_000 })
      .toHaveAttribute("download", "director-short.mp4");
    expect(page.getByText("It's silent on purpose", { exact: false }).query()).toBeNull();
  });

  it("says when this browser can't put the short together", async () => {
    await commands.storageCors();
    vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [planShot({ kind: "photo", title: "Smile", durationSeconds: 0.5 })] }),
    );
    await commands.fakeDirector(videoId, {
      takes: [
        take({ fileId: await uploaded("director-take-photo", await photo()), kind: "photo" }),
      ],
    });
    const page = await openEditor(videoId, "voice");
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Your short couldn't be put together in this browser. Try Chrome or Safari.",
      );
    await expect.element(page.getByRole("button", { name: "Next" })).toBeEnabled();
  });
});
