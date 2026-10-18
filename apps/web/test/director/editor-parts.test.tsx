/** The editor's parts: its settings, the board of shots and takes, and the player. */
import type { DirectorShot, DirectorTake, Shot } from "@repo/contracts/api";
import { type DirectorTakeId, directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { EditPlayer } from "@/modules/director/components/edit-player";
import { SoundPanel, StylePicker } from "@/modules/director/components/edit-tools";
import { ShotBoard } from "@/modules/director/components/shot-board";
import type { MediaState } from "@/modules/director/hooks/use-take-media";
import { type Clip, clipsOf, editLines } from "@/modules/director/lib/edit";
import { type Picks, pickedTakes } from "@/modules/director/lib/picks";
import { renderPage } from "../render";
import { photo, planShot, recordVideo } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

let filmed = 0;

/** A take, filmed after every one made before it. */
function directorTake(overrides: Partial<DirectorTake> = {}): DirectorTake {
  filmed += 1;
  return {
    id: directorTakeIdSchema.parse(crypto.randomUUID()),
    shotIndex: 0,
    fileId: fileIdSchema.parse(crypto.randomUUID()),
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    createdAt: new Date(filmed * 1000),
    ...overrides,
  };
}

/** A shot as the API lists it: its takes newest first. */
function boardShot(
  index: number,
  takes: DirectorTake[],
  {
    picked = null,
    needsRetake = false,
  }: { picked?: DirectorTake | null; needsRetake?: boolean } = {},
): DirectorShot {
  return {
    index,
    takes: [...takes].reverse(),
    pickedTakeId: picked?.id ?? null,
    needsRetake,
  };
}

/** The clips for `shots`, with each index's take. */
const clipsFor = (shots: Shot[], takes: Record<number, Partial<DirectorTake>> = {}) =>
  clipsOf(
    shots,
    new Map(
      Object.entries(takes).map(([index, take]) => [
        Number(index),
        directorTake({ shotIndex: Number(index), ...take }),
      ]),
    ),
  );

/** A take in memory, as useTakeMedia keeps it. */
function media(blob: Blob): MediaState {
  const url = URL.createObjectURL(blob);
  return { blob, url, poster: url };
}

describe("the editor's settings", () => {
  it("picks a caption style", async () => {
    const onChange = vi.fn();
    const page = await renderPage(<StylePicker value="pop" onChange={onChange} />);
    await expect.element(page.getByRole("group", { name: "Caption style" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Pop" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(page.getByRole("button", { name: "Classic" }));
    expect(onChange).toHaveBeenCalledWith("classic");
  });

  it("switches the takes' sound, or says why there's none", async () => {
    const onChange = vi.fn();
    const page = await renderPage(<SoundPanel voice on onChange={onChange} />);
    const toggle = page.getByRole("switch", { name: "Keep your voice in the short" });
    await expect.element(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("says a short filmed to the original is silent", async () => {
    const page = await renderPage(<SoundPanel voice={false} on={false} onChange={vi.fn()} />);
    await expect.element(page.getByText("It's silent on purpose", { exact: false })).toBeVisible();
    expect(page.getByRole("switch").query()).toBeNull();
  });
});

describe("the board of shots", () => {
  const shots = [
    planShot({ title: "Walk in", durationSeconds: 4.5 }),
    planShot({ kind: "photo", title: "The look", durationSeconds: 1 }),
    planShot({ title: "Wave", durationSeconds: 2 }),
  ];
  const [first, second, third] = [
    directorTake({ score: 82, feedback: "Lovely light, keep the smile." }),
    directorTake({ score: 40, feedback: "Too dark." }),
    directorTake({ status: "reviewing" }),
  ];
  const look = directorTake({ shotIndex: 1, kind: "photo", score: 54, feedback: "Step closer." });

  async function board(
    options: { listed?: DirectorShot[]; picks?: Picks; time?: number; playing?: boolean } = {},
  ) {
    const listed = options.listed ?? [
      boardShot(0, [first, second, third], { picked: first }),
      boardShot(1, [look], { picked: look, needsRetake: true }),
      boardShot(2, []),
    ];
    const picks = options.picks ?? {};
    const onPick = vi.fn();
    const onSeek = vi.fn();
    const clips = clipsOf(shots, pickedTakes(listed, picks));
    const page = await renderPage(
      <div style={{ height: 420, width: 390 }}>
        <ShotBoard
          clips={clips}
          shots={listed}
          media={new Map()}
          picks={picks}
          time={options.time ?? 0}
          playing={options.playing ?? false}
          shotHref={(index) => `/director/abcdefghijk/shoot?shot=${index}&audio=voice`}
          onPick={onPick}
          onSeek={onSeek}
        />
      </div>,
    );
    return { page, onPick, onSeek, clips };
  }

  it("lays the shots out in order, each as wide as it is long, its takes in the order filmed", async () => {
    const { page } = await board();
    const columns = page.getByRole("group").elements();
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual([
      "Shot 1 · Walk in",
      "Shot 2 · The look",
      "Shot 3 · Wave",
    ]);
    // 56px a second, within 156 to 320.
    expect(columns.map((column) => (column as HTMLElement).style.width)).toEqual([
      "252px",
      "156px",
      "156px",
    ]);
    const walkIn = page.getByRole("radiogroup", { name: "Takes of shot 1" });
    const takes = walkIn.getByRole("radio").elements();
    expect(takes.map((take) => take.closest("label")?.textContent)).toEqual([
      expect.stringMatching(/^Take 182\/100Director's pick/),
      expect.stringMatching(/^Take 240\/100$/),
      expect.stringMatching(/^Take 3Director is reviewing this take…$/),
    ]);
    // Director's pick plays, with what Director thought of it.
    await expect.element(walkIn.getByRole("radio", { name: /Take 1/ })).toBeChecked();
    await expect.element(page.getByText("Lovely light, keep the smile.")).toBeVisible();
    expect(page.getByText("Too dark.").query()).toBeNull();
  });

  it("puts Director's note on a shot whose best take scored too low, with a retake", async () => {
    const { page } = await board();
    const look = page.getByRole("group", { name: "Shot 2 · The look" });
    await expect.element(look.getByText("Needs a retake")).toBeVisible();
    // Said once, in the note, not again on the take's card.
    await expect.element(look.getByText("Step closer.")).toBeVisible();
    expect(look.getByText("Step closer.").elements()).toHaveLength(1);
    await expect
      .element(look.getByRole("link", { name: "Retake" }))
      .toHaveAttribute("href", "/director/abcdefghijk/shoot?shot=1&audio=voice");
    // A shot that doesn't need one still offers it, quietly.
    const walkIn = page.getByRole("group", { name: "Shot 1 · Walk in" });
    expect(walkIn.getByText("Needs a retake").query()).toBeNull();
    await expect
      .element(walkIn.getByRole("link", { name: "Retake" }))
      .toHaveAttribute("href", "/director/abcdefghijk/shoot?shot=0&audio=voice");
  });

  it("says a note's retake even when Director gave no feedback", async () => {
    const quiet = directorTake({ shotIndex: 1, kind: "photo", score: 30 });
    const { page } = await board({
      listed: [
        boardShot(0, [first], { picked: first }),
        boardShot(1, [quiet], { picked: quiet, needsRetake: true }),
        boardShot(2, []),
      ],
    });
    const look = page.getByRole("group", { name: "Shot 2 · The look" });
    await expect.element(look.getByText("Needs a retake")).toBeVisible();
    await expect.element(look.getByRole("link", { name: "Retake" })).toBeVisible();
  });

  it("offers to film a shot that isn't yet", async () => {
    const { page } = await board();
    const wave = page.getByRole("group", { name: "Shot 3 · Wave" });
    await expect.element(wave.getByText("Not filmed yet")).toBeVisible();
    await expect
      .element(wave.getByRole("link", { name: "Film it" }))
      .toHaveAttribute("href", "/director/abcdefghijk/shoot?shot=2&audio=voice");
    expect(wave.getByRole("radiogroup").query()).toBeNull();
  });

  it("steps through a shot's takes, no further than the first or last", async () => {
    const { page, onPick } = await board();
    const walkIn = page.getByRole("group", { name: "Shot 1 · Walk in" });
    await expect.element(walkIn.getByText("Take 1 of 3")).toBeVisible();
    await expect.element(walkIn.getByRole("button", { name: "Previous take" })).toBeDisabled();
    await userEvent.click(walkIn.getByRole("button", { name: "Next take" }));
    expect(onPick).toHaveBeenLastCalledWith(0, second.id);
    // Tapping a take picks it too.
    await userEvent.click(walkIn.getByText("Take 3", { exact: true }));
    expect(onPick).toHaveBeenLastCalledWith(0, third.id);
    // One take: nothing to step through.
    const look = page.getByRole("group", { name: "Shot 2 · The look" });
    expect(look.getByRole("button", { name: "Next take" }).query()).toBeNull();
  });

  it("steps back from the member's own pick", async () => {
    const { page, onPick } = await board({ picks: { 0: third.id } });
    const walkIn = page.getByRole("group", { name: "Shot 1 · Walk in" });
    await expect.element(walkIn.getByText("Take 3 of 3")).toBeVisible();
    await expect.element(walkIn.getByRole("button", { name: "Next take" })).toBeDisabled();
    await userEvent.click(walkIn.getByRole("button", { name: "Previous take" }));
    expect(onPick).toHaveBeenLastCalledWith(0, second.id);
  });

  it("plays from a shot when its title is tapped, and shows how far the clock is through each", async () => {
    const { page, onSeek, clips } = await board({ time: 5 });
    await userEvent.click(page.getByRole("button", { name: "Play from shot 2: The look" }));
    expect(onSeek).toHaveBeenCalledWith(clips[1]);
    const bars = [...document.querySelectorAll<HTMLElement>("[style*='scaleX']")];
    expect(bars.map((bar) => bar.style.transform)).toEqual([
      "scaleX(1)",
      "scaleX(0.5)",
      "scaleX(0)",
    ]);
  });

  it("brings the shot playing into view while it plays, and not while the member looks", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    await board({ time: 5 });
    expect(scroll).not.toHaveBeenCalled();
    await board({ time: 5, playing: true });
    await expect.poll(() => scroll.mock.calls.length).toBe(1);
    expect(scroll.mock.contexts[0]).toHaveProperty("ariaLabel", "Shot 2 · The look");
  });
});

describe("picking another take", () => {
  // The preview plays each shot's picked take, in the shots' order.
  it("changes what the preview plays for that shot, and nothing else", async () => {
    const shots = [
      planShot({ title: "Walk in", durationSeconds: 1 }),
      planShot({ kind: "photo", title: "Smile", durationSeconds: 1 }),
    ];
    const [walk1, walk2] = [directorTake({ score: 90 }), directorTake({ score: 70 })];
    const smile = directorTake({ shotIndex: 1, kind: "photo", score: 80 });
    const listed = [
      boardShot(0, [walk1, walk2], { picked: walk1 }),
      boardShot(1, [smile], { picked: smile }),
    ];
    const [video, picture] = await Promise.all([recordVideo(1), photo()]);
    const taken = new Map<DirectorTakeId, MediaState>([
      [walk1.id, media(video)],
      [walk2.id, media(video)],
      [smile.id, media(picture)],
    ]);
    function Editor() {
      const [picks, setPicks] = useState<Picks>({});
      const clips = clipsOf(shots, pickedTakes(listed, picks));
      return (
        <div style={{ height: 600 }}>
          <div style={{ height: 300 }}>
            <EditPlayer
              clips={clips}
              media={taken}
              time={0}
              playing={false}
              clock={() => 0}
              lines={[]}
              style="pop"
              sound={false}
              onStall={vi.fn()}
            />
          </div>
          <ShotBoard
            clips={clips}
            shots={listed}
            media={taken}
            picks={picks}
            time={0}
            playing={false}
            shotHref={(index) => `/director/abcdefghijk/shoot?shot=${index}&audio=voice`}
            onPick={(shot, take) => setPicks((now) => ({ ...now, [shot]: take }))}
            onSeek={vi.fn()}
          />
        </div>
      );
    }
    const page = await renderPage(<Editor />);
    const preview = () =>
      [...document.querySelectorAll<HTMLElement>("[data-take]")].map(
        (element) => element.dataset.take,
      );
    await expect.poll(preview).toEqual([walk1.id, smile.id]);
    // Each card shows its take's frame once it's in memory.
    expect(document.querySelectorAll("label img")).toHaveLength(3);

    await userEvent.click(page.getByRole("button", { name: "Next take" }));
    await expect.poll(preview).toEqual([walk2.id, smile.id]);
    await expect.element(page.getByText("Take 2 of 2")).toBeVisible();
  });
});

describe("the edit player", () => {
  const shots = [
    planShot({
      title: "Walk in",
      durationSeconds: 1.5,
      script: [{ startSeconds: 0, endSeconds: 1, text: "Hi there" }],
    }),
    planShot({ kind: "photo", title: "Smile", durationSeconds: 1 }),
    planShot({ title: "Wave", durationSeconds: 1 }),
  ];

  /** Each clip's take in memory, as `states` (by clip index) say. */
  const mediaOf = (clips: Clip[], states: Record<number, MediaState>) =>
    new Map(
      clips.flatMap((clip) => {
        const state = states[clip.index];
        return clip.take && state ? [[clip.take.id, state] as const] : [];
      }),
    );

  async function player(clips: Clip[], map: Map<DirectorTakeId, MediaState>) {
    const onStall = vi.fn();
    let update: (next: { time?: number; playing?: boolean; sound?: boolean }) => void = () =>
      undefined;
    function Player() {
      const [state, setState] = useState({ time: 0, playing: false, sound: false });
      update = (next) => setState((now) => ({ ...now, ...next }));
      return (
        <div style={{ height: 400 }}>
          <EditPlayer
            clips={clips}
            media={map}
            time={state.time}
            playing={state.playing}
            clock={() => state.time}
            lines={editLines(clips)}
            style="pop"
            sound={state.sound}
            onStall={onStall}
          />
        </div>
      );
    }
    const page = await renderPage(<Player />);
    return { page, onStall, update: (next: Parameters<typeof update>[0]) => update(next) };
  }

  it("plays the clip under the clock from its kept part, the others paused and hidden", async () => {
    const video = await recordVideo(2);
    const picture = await photo();
    const clips = clipsFor(shots, {
      0: { bestStartMs: 500, bestEndMs: 1500 },
      1: { kind: "photo" },
      2: {},
    });
    const map = mediaOf(clips, { 0: media(video), 1: media(picture), 2: media(video) });
    const { page, update, onStall } = await player(clips, map);
    const [first, last] = document.querySelectorAll("video");
    // Hidden, so out of the accessibility tree until it's on screen.
    const image = page.elementLocator(document.querySelector("img[alt='Smile']") as HTMLElement);
    await expect.element(image).toHaveClass("invisible");
    expect(first?.className).not.toContain("invisible");
    expect(last?.className).toContain("invisible");

    // Paused, the active video sits exactly where the clock is.
    update({ time: 0.4 });
    await expect.poll(() => first?.currentTime).toBeCloseTo(0.9, 2);
    expect(first?.paused).toBe(true);

    update({ playing: true });
    await expect.poll(() => first?.paused).toBe(false);
    expect(first?.muted).toBe(true);
    expect(last?.paused).toBe(true);
    // The takes' sound, when it's on.
    update({ sound: true });
    await expect.poll(() => first?.muted).toBe(false);
    expect(last?.muted).toBe(false);

    // A photo zooms slowly while it's on screen.
    update({ time: 1.5, playing: false });
    await expect.element(image).not.toHaveClass("invisible");
    expect(image.element().style.transform).toBe("scale(1.03)");
    await expect.poll(() => first?.paused).toBe(true);
    expect(first?.className).toContain("invisible");
    expect(onStall).not.toHaveBeenCalled();
    // The captions are drawn over it all.
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("stops the clock when a video can't play, but not when a pause cut its start short", async () => {
    const video = await recordVideo(0.5);
    const clips = clipsFor(shots, { 0: {} });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("paused", "AbortError"))
      .mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    const { update, onStall } = await player(clips, mediaOf(clips, { 0: media(video) }));
    update({ playing: true });
    await expect.poll(() => play.mock.calls.length).toBe(1);
    update({ time: 0.1 });
    await expect.poll(() => play.mock.calls.length).toBe(2);
    await expect.poll(() => onStall.mock.calls.length).toBe(1);
  });

  it.each([
    [{ status: "reviewing" as const }, undefined, "Director is reviewing this take…"],
    [{}, "failed" as const, "This take couldn't be loaded. Try a retake."],
  ])("holds the clip's place while it can't play (%o)", async (take, state, message) => {
    const clips = clipsFor(shots, { 0: take });
    const { page } = await player(clips, mediaOf(clips, state ? { 0: state } : {}));
    await expect.element(page.getByText("Walk in")).toBeVisible();
    await expect.element(page.getByText(message)).toBeVisible();
  });

  it("shows just the captions for an edit with nothing in it", async () => {
    await player([], new Map());
    expect(document.querySelector("video, img")).toBeNull();
    expect(document.querySelector("canvas")).not.toBeNull();
  });

  it("holds a place for a shot not filmed yet, and waits for one loading", async () => {
    const clips = clipsFor(shots, { 1: { kind: "photo" } });
    const { page, update } = await player(clips, mediaOf(clips, { 1: "loading" }));
    await expect.element(page.getByText("Shot 1 isn't filmed yet")).toBeVisible();
    update({ time: 1.6 });
    await expect.element(page.getByRole("status", { name: "Loading this take…" })).toBeVisible();
    expect(page.getByText("isn't filmed yet", { exact: false }).query()).toBeNull();
  });
});
