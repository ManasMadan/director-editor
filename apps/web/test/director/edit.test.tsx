/**
 * The editor: the member's takes shot by shot (downloaded from storage as they're picked),
 * Director's picks and notes, and the video put together in the browser and saved to
 * My media.
 */
import { uploadFile } from "@repo/client/api/files/upload";
import type { UploadPurpose } from "@repo/contracts/files";
import { fileIdSchema } from "@repo/contracts/ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import { EditPage, MediaPage } from "@/modules/director";
import { FRESH } from "@/modules/director/lib/memory";
import { stitch } from "@/modules/director/lib/stitch";
import { cleanup, currentUrl, renderPage } from "../render";
import { api, signUp, type User } from "../users";
import { newVideoId, photo, planShot, readyPlan, recordVideo, shotPlan, take } from "./support";

// Rendering is the browser's real work here; one test swaps in an oversized result. A spy
// (not a factory) keeps the real module loaded, so its coverage isn't zeroed.
vi.mock("@/modules/director/lib/stitch", { spy: true });

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

/** How many uploads the page has completed so far (the takes' included). */
const completed = () => commands.answeredRequests("/rpc/files/completeUpload");

/**
 * The video the editor uploaded, passed by the worker once the page has completed its
 * upload (`before`: the uploads completed before it): passed any sooner, its bytes leave
 * quarantine before the API sees them there.
 */
async function passCut(user: User, before: number) {
  await expect.poll(completed, { timeout: 40_000 }).toBeGreaterThan(before);
  const [row] = await commands.sql<{ id: string }>(
    "SELECT id::text FROM files.file WHERE user_id = $1 AND purpose = 'director-cut-video' AND status = 'pending'",
    [user.id],
  );
  await commands.checkUpload(row?.id as string);
}

async function openEditor(videoId: string, audio: string | undefined, wrap = false) {
  return renderPage(<EditPage videoId={videoId} audio={audio} wrap={wrap} />, {
    url: `/director/${videoId}/edit`,
  });
}

/** The editor's clock, as it reads. */
const clock = () => document.querySelector("p.font-mono span")?.textContent;

/** The takes the preview has in it, in the shots' order. */
const preview = () =>
  [...document.querySelectorAll<HTMLElement>("[data-take]")].map((element) => element.dataset.take);

/** A take filmed `seconds` ago, as the AI stand-in lists it. */
const filmedAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

describe("the editor before it can open", () => {
  it("waits for the plan, and says when there isn't one", async () => {
    await signUp();
    const pending = newVideoId();
    await commands.fakeDirector(pending, { plan: { status: "analyzing", plan: null } });
    const page = await openEditor(pending, "voice");
    await expect.element(page.getByRole("status", { name: "Loading your takes…" })).toBeVisible();
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

  it("calls the wrap on arriving from the last shot, aloud, until it's tapped away", async () => {
    const speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    await signUp();
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan());
    const page = await openEditor(videoId, "voice", true);
    const wrap = page.getByRole("button", { name: /That's a wrap!/ });
    await expect.element(wrap).toBeVisible();
    await expect
      .poll(() => speak.mock.calls.map(([utterance]) => utterance.text))
      .toContain("That's a wrap! You did it. Let's watch what you made!");
    await userEvent.click(wrap);
    await expect.element(wrap).not.toBeInTheDocument();
  });

  it("calls the wrap silently for a member who turned Director's voice off", async () => {
    const speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
    const user = await signUp();
    window.localStorage.setItem(
      `director.memory.${user.id}`,
      JSON.stringify({ ...FRESH, speak: false }),
    );
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan());
    const page = await openEditor(videoId, "voice", true);
    await expect.element(page.getByRole("button", { name: /That's a wrap!/ })).toBeVisible();
    expect(speak).not.toHaveBeenCalled();
  });

  it("says when the takes can't be read", async () => {
    await signUp();
    const videoId = newVideoId();
    await readyPlan(videoId, shotPlan());
    await commands.failRequests("/rpc/director/shots", { status: 502 });
    const page = await openEditor(videoId, "voice");
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(page.getByRole("button", { name: "Save video" }).query()).toBeNull();
  });
});

describe("Director's notes", () => {
  it("asks for a retake of a shot whose best take scored below 60, and of no other", async () => {
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [planShot({ title: "Walk in" }), planShot({ title: "Wave" })] }),
    );
    // The files don't matter here: the scores do.
    await commands.fakeDirector(videoId, {
      takes: [
        take({
          fileId: fileIdSchema.parse(crypto.randomUUID()),
          score: 59,
          feedback: "Hold the phone still.",
        }),
        take({
          fileId: fileIdSchema.parse(crypto.randomUUID()),
          shotIndex: 1,
          score: 60,
          feedback: "Nice wave.",
        }),
      ],
    });
    const page = await openEditor(videoId, "voice");
    const walkIn = page.getByRole("group", { name: "Shot 1 · Walk in" });
    await expect.element(walkIn.getByText("Needs a retake")).toBeVisible();
    await expect.element(walkIn.getByText("Hold the phone still.")).toBeVisible();
    await expect
      .element(walkIn.getByRole("link", { name: "Retake" }))
      .toHaveAttribute("href", `/director/${videoId}/shoot?shot=0&audio=voice`);
    const wave = page.getByRole("group", { name: "Shot 2 · Wave" });
    await expect.element(wave.getByText("Nice wave.")).toBeVisible();
    expect(wave.getByText("Needs a retake").query()).toBeNull();
  });
});

/** Recording only WebM, as Firefox does. */
function webmOnly() {
  const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
  vi.spyOn(MediaRecorder, "isTypeSupported").mockImplementation(
    (type) => !type.startsWith("video/mp4") && supported(type),
  );
}

/** A ready short of a 1-second video shot and a half-second photo, with a take of each. */
async function filmedShort(audio: "music" | "speech" = "music") {
  const user = await signUp();
  const videoId = newVideoId();
  await readyPlan(
    videoId,
    shotPlan({
      audio,
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
  const takes = [
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
  ];
  await commands.fakeDirector(videoId, { takes });
  return { user, videoId, takes };
}

// Takes are downloaded from RustFS: the files profile (`bun run test:integration:files`).
describe("the editor", { tags: ["files"] }, () => {
  // Records, uploads and downloads takes before walking the board: past the default 30
  // seconds on a busy CI runner.
  it("plays Director's picks, changes one, undoes it, and sends the member to film what's left", {
    timeout: 60_000,
  }, async () => {
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
    const [walkFile, smileFile] = await Promise.all([
      uploaded("director-take-video", video),
      uploaded("director-take-photo", picture),
    ]);
    const best = {
      ...take({
        fileId: walkFile,
        score: 82,
        feedback: "Lovely light, keep the smile.",
        bestStartMs: 200,
        bestEndMs: 1800,
      }),
      createdAt: filmedAgo(60),
    };
    const again = { ...take({ fileId: walkFile, score: 45 }), createdAt: filmedAgo(30) };
    const smile = take({ fileId: smileFile, shotIndex: 1, kind: "photo", score: 90 });
    await commands.fakeDirector(videoId, { takes: [again, best, smile] });
    const page = await openEditor(videoId, "voice");

    await expect.element(page.getByRole("heading", { name: "Morning routine" })).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Back" }))
      .toHaveAttribute("href", `/director/${videoId}`);
    // One shot still to film: the video can't be saved yet.
    await expect.element(page.getByText("1 shot still to film.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save video" })).toBeDisabled();
    // Director's pick plays: the better take, not the newer one.
    const walkIn = page.getByRole("group", { name: "Shot 1 · Walk in" });
    await expect.element(walkIn.getByRole("radio", { name: /Take 1/ })).toBeChecked();
    await expect.element(walkIn.getByText("Director's pick")).toBeVisible();
    await expect.element(walkIn.getByText("Lovely light, keep the smile.")).toBeVisible();
    await expect.poll(preview).toEqual([best.id, smile.id]);
    expect(clock()).toBe("00:00");

    // Playing, then pausing.
    await userEvent.click(page.getByRole("button", { name: "Play", exact: true }));
    await expect.poll(clock).toBe("00:01");
    await userEvent.click(page.getByRole("button", { name: "Pause" }));
    await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

    // The other take, stepped to: the preview plays it from its shot.
    await userEvent.click(walkIn.getByRole("button", { name: "Next take" }));
    await expect.element(walkIn.getByText("Take 2 of 2")).toBeVisible();
    await expect.poll(preview).toEqual([again.id, smile.id]);
    expect(clock()).toBe("00:00");
    // Undone and redone.
    await userEvent.click(page.getByRole("button", { name: "Undo" }));
    await expect.poll(preview).toEqual([best.id, smile.id]);
    await userEvent.click(page.getByRole("button", { name: "Redo" }));
    await expect.poll(preview).toEqual([again.id, smile.id]);
    await userEvent.click(page.getByRole("button", { name: "Undo" }));

    // A shot's title plays from it.
    await userEvent.click(page.getByRole("button", { name: "Play from shot 2: Smile" }));
    await expect.poll(clock).toBe("00:01");

    // The caption style, and the takes' sound.
    await userEvent.click(page.getByRole("button", { name: "Captions" }));
    await userEvent.click(page.getByRole("button", { name: "Classic" }));
    await expect
      .element(page.getByRole("button", { name: "Classic" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(page.getByRole("button", { name: "Sound" }));
    expect(page.getByRole("group", { name: "Caption style" }).query()).toBeNull();
    await userEvent.click(page.getByRole("switch", { name: "Keep your voice in the short" }));
    await expect.element(page.getByRole("switch")).not.toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Sound" }));
    expect(page.getByRole("switch").query()).toBeNull();

    // The shot still to film, offered on the board.
    const wave = page.getByRole("group", { name: "Shot 3 · Wave" });
    await userEvent.click(wave.getByRole("link", { name: "Film it" }));
    expect(currentUrl()).toBe(`/director/${videoId}/shoot?shot=2&audio=voice`);
  });

  it("saves the video, silent when it was filmed to the original, and it shows in My media", {
    timeout: 60_000,
  }, async () => {
    await commands.storageCors();
    webmOnly();
    const { user, videoId, takes } = await filmedShort();
    const page = await openEditor(videoId, undefined);
    const save = page.getByRole("button", { name: "Save video" });
    await expect.element(save).toBeEnabled();
    const before = await completed();
    await userEvent.click(save);
    await expect
      .element(page.getByRole("status", { name: /Putting your video together/ }))
      .toBeVisible();
    await expect.element(save).toBeDisabled();
    await expect
      .element(page.getByRole("status", { name: "Saving to My media…" }), { timeout: 20_000 })
      .toBeVisible();
    await passCut(user, before);

    await expect
      .element(page.getByRole("heading", { name: "Saved to My media" }), { timeout: 20_000 })
      .toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open My media" }))
      .toHaveAttribute("href", "/media");
    const download = page.getByRole("link", { name: "Download" });
    await expect.element(download).toHaveAttribute("download", "director-short.webm");
    await expect.element(download).toHaveAttribute("href", expect.stringMatching(/^blob:/));
    expect(document.querySelector("video[controls] track")?.getAttribute("src")).toMatch(/^blob:/);
    // Saved with the take each shot played.
    const [cut] = await api.director.media();
    expect(cut).toMatchObject({
      videoId,
      title: "Morning routine",
      templateTitle: "Morning routine",
      picks: { 0: takes[0]?.id, 1: takes[1]?.id },
      durationMs: 1300,
    });

    await userEvent.click(page.getByRole("button", { name: "Back to editing" }));
    await expect
      .element(page.getByRole("heading", { name: "Saved to My media" }))
      .not.toBeInTheDocument();
    await expect.element(save).toBeEnabled();

    // And in My media, under its template, ready to play.
    cleanup();
    const media = await renderPage(<MediaPage />, { url: "/media" });
    await expect.element(media.getByRole("heading", { name: "Morning routine" })).toBeVisible();
    await expect.element(media.getByText("1 video")).toBeVisible();
    await expect.element(media.getByText("Not published")).toBeVisible();
    await userEvent.click(media.getByRole("button", { name: "Play Morning routine" }));
    await expect
      .poll(() => document.querySelector("video")?.getAttribute("src"))
      .toContain(cut?.fileId ?? "no file");
  });

  it("refuses a video too long to save before putting it together", async () => {
    await commands.storageCors();
    await signUp();
    const videoId = newVideoId();
    // Four minutes of photos: past what a saved video may be at its bitrate.
    const long = planShot({ kind: "photo", title: "Hold", durationSeconds: 60 });
    await readyPlan(videoId, shotPlan({ shots: [long, long, long, long] }));
    const fileId = await uploaded("director-take-photo", await photo());
    await commands.fakeDirector(videoId, {
      takes: [0, 1, 2, 3].map((shotIndex) => take({ fileId, shotIndex, kind: "photo" })),
    });
    const page = await openEditor(videoId, "voice");
    await userEvent.click(page.getByRole("button", { name: "Save video" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "This video is too long to save: videos can be up to 3 minutes. Pick shorter takes, or film shorter shots.",
      );
    expect(page.getByRole("status", { name: /Putting your video together/ }).query()).toBeNull();
  });

  it("refuses a video that came out bigger than a saved video may be, before uploading it", {
    timeout: 60_000,
  }, async () => {
    await commands.storageCors();
    const { user, videoId } = await filmedShort();
    const page = await openEditor(videoId, undefined);
    const save = page.getByRole("button", { name: "Save video" });
    await expect.element(save).toBeEnabled();
    // A video a byte over the limit, as a long one with lots going on can come out.
    vi.mocked(stitch).mockResolvedValueOnce(
      new Blob([new Uint8Array(100_000_001)], { type: "video/webm" }),
    );
    await userEvent.click(save);
    await expect
      .element(page.getByRole("alert"), { timeout: 20_000 })
      .toHaveTextContent(
        "This video is too long to save: videos can be up to 3 minutes. Pick shorter takes, or film shorter shots.",
      );
    const cuts = await commands.sql(
      "SELECT id FROM files.file WHERE user_id = $1 AND purpose = 'director-cut-video'",
      [user.id],
    );
    expect(cuts).toEqual([]);
    await expect.element(save).toBeEnabled();
  });

  it("says when this browser can't put the video together", async () => {
    await commands.storageCors();
    vi.spyOn(MediaRecorder, "isTypeSupported").mockReturnValue(false);
    const { videoId } = await filmedShort();
    const page = await openEditor(videoId, "voice");
    await userEvent.click(page.getByRole("button", { name: "Save video" }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Your video couldn't be put together in this browser. Try Chrome or Safari.",
      );
    await expect.element(page.getByRole("button", { name: "Save video" })).toBeEnabled();
  });

  it("says why the video couldn't be saved, and lets the member try again", {
    timeout: 60_000,
  }, async () => {
    await commands.storageCors();
    const { videoId } = await filmedShort("speech");
    const page = await openEditor(videoId, "voice");
    await commands.failRequests("/rpc/files/createUpload", { status: 503 });
    await userEvent.click(page.getByRole("button", { name: "Save video" }));
    await expect.element(page.getByRole("alert"), { timeout: 20_000 }).toBeVisible();
    expect(await commands.failedRequests("/rpc/files/createUpload")).toBe(1);
    await expect.element(page.getByRole("button", { name: "Save video" })).toBeEnabled();
  });

  it("plays Director's cut as the wrap opens the editor", async () => {
    await commands.storageCors();
    await signUp();
    const videoId = newVideoId();
    await readyPlan(
      videoId,
      shotPlan({ shots: [planShot({ kind: "photo", title: "Smile", durationSeconds: 1 })] }),
    );
    await commands.fakeDirector(videoId, {
      takes: [
        take({
          fileId: await uploaded("director-take-photo", await photo()),
          kind: "photo",
        }),
      ],
    });
    const page = await openEditor(videoId, "voice", true);
    await expect.element(page.getByRole("button", { name: "Pause" })).toBeVisible();
    // The wrap steps aside by itself once it's been read.
    await expect
      .element(page.getByRole("button", { name: /That's a wrap!/ }), { timeout: 8_000 })
      .not.toBeInTheDocument();
  });

  it("keeps the member's voice in an MP4, where the browser records one", {
    timeout: 60_000,
  }, async () => {
    await commands.storageCors();
    const user = await signUp();
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
    const before = await completed();
    await userEvent.click(page.getByRole("button", { name: "Save video" }));
    await passCut(user, before);
    await expect
      .element(page.getByRole("link", { name: "Download" }), { timeout: 20_000 })
      .toHaveAttribute("download", "director-short.mp4");
  });
});
