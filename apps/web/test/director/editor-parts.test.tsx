/** The editor's parts: the tools, the clip panel, the timeline and the player. */
import type { DirectorTake, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ClipPanel } from "@/modules/director/components/clip-panel";
import { EditPlayer } from "@/modules/director/components/edit-player";
import { EditTimeline } from "@/modules/director/components/edit-timeline";
import {
  EditTools,
  SoundPanel,
  StylePicker,
  TextEditor,
  type Tool,
} from "@/modules/director/components/edit-tools";
import type { MediaState } from "@/modules/director/hooks/use-take-media";
import { type Clip, clipsOf, type EditLine, editLines } from "@/modules/director/lib/edit";
import { renderPage } from "../render";
import { photo, recordVideo, shot } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

function directorTake(overrides: Partial<DirectorTake> = {}): DirectorTake {
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
    createdAt: new Date(),
    ...overrides,
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

describe("the editor's tools", () => {
  function Tools({ onRetake }: { onRetake: (() => void) | null }) {
    const [tool, setTool] = useState<Tool | null>(null);
    return <EditTools tool={tool} onTool={setTool} onRetake={onRetake} />;
  }

  it("opens one tool at a time, and closes it on a second tap", async () => {
    const page = await renderPage(<Tools onRetake={null} />);
    const captions = page.getByRole("button", { name: "Captions" });
    const text = page.getByRole("button", { name: "Text" });
    const sound = page.getByRole("button", { name: "Sound" });
    await userEvent.click(captions);
    await expect.element(captions).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(text);
    await expect.element(text).toHaveAttribute("aria-pressed", "true");
    await expect.element(captions).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(sound);
    await expect.element(sound).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(sound);
    await expect.element(sound).toHaveAttribute("aria-pressed", "false");
    // Nothing to retake without a clip in focus.
    await expect.element(page.getByRole("button", { name: "Retake" })).toBeDisabled();
  });

  it("retakes the clip in focus", async () => {
    const onRetake = vi.fn();
    const page = await renderPage(<Tools onRetake={onRetake} />);
    await userEvent.click(page.getByRole("button", { name: "Retake" }));
    expect(onRetake).toHaveBeenCalledOnce();
  });

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

  const line: EditLine = {
    key: "0:1",
    clip: 0,
    text: "Coffee first.",
    startSeconds: 1,
    endSeconds: 2,
  };

  it("says how to pick a caption before one is", async () => {
    const page = await renderPage(<TextEditor line={null} onSave={vi.fn()} />);
    await expect
      .element(page.getByText("Tap a caption on the timeline to change its words."))
      .toBeVisible();
  });

  it("keeps a caption's new words, trimmed, when they changed", async () => {
    const onSave = vi.fn();
    const page = await renderPage(<TextEditor line={line} onSave={onSave} />);
    const input = page.getByRole("textbox", { name: "Caption text" });
    await expect.element(input).toHaveValue("Coffee first.");
    // Unchanged, or emptied: nothing to keep.
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    await userEvent.fill(input, "   ");
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.fill(input, "  Tea first.  ");
    await userEvent.click(page.getByRole("button", { name: "Done" }));
    expect(onSave).toHaveBeenCalledWith(line, "Tea first.");
    // Leaving the field keeps them too.
    await userEvent.fill(input, "Water first.");
    await userEvent.click(document.body);
    expect(onSave).toHaveBeenLastCalledWith(line, "Water first.");
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

describe("the clip panel", () => {
  const shots = [shot({ title: "Walk in" }), shot({ kind: "photo", title: "The look" })];

  it("offers to film a shot that isn't yet", async () => {
    const [, clip] = clipsFor(shots);
    const page = await renderPage(
      <ClipPanel videoId="abcdefghijk" clip={clip as Clip} audio="voice" />,
    );
    await expect.element(page.getByText("Shot 2 · The look")).toBeVisible();
    await expect.element(page.getByText("Not filmed yet")).toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Film it" }))
      .toHaveAttribute("href", "/director/abcdefghijk/shoot?shot=1&audio=voice");
    expect(document.querySelector(".lucide-camera")).not.toBeNull();
  });

  it.each(["pending", "reviewing"] as const)(
    "waits for Director's review of a %s take",
    async (status) => {
      const [clip] = clipsFor(shots, { 0: { status } });
      const page = await renderPage(
        <ClipPanel videoId="abcdefghijk" clip={clip as Clip} audio="original" />,
      );
      await expect.element(page.getByText("Director is reviewing this take…")).toBeVisible();
      await expect
        .element(page.getByRole("link", { name: "Retake" }))
        .toHaveAttribute("href", "/director/abcdefghijk/shoot?shot=0&audio=original");
    },
  );

  it.each([
    ["DIRECTOR_VIDEO_UNREADABLE", "Director couldn't watch this short."],
    [null, "Director couldn't review this take. Record it again."],
  ])("says why the review failed (%s)", async (error, message) => {
    const [clip] = clipsFor(shots, { 0: { status: "failed", error } });
    const page = await renderPage(
      <ClipPanel videoId="abcdefghijk" clip={clip as Clip} audio="voice" />,
    );
    await expect.element(page.getByText(message, { exact: false })).toBeVisible();
  });

  it("shows Director's review: the score, the feedback and the part kept", async () => {
    const [clip] = clipsFor(shots, {
      0: { score: 87, feedback: "Lovely light.", bestStartMs: 1200, bestEndMs: 3500 },
    });
    const page = await renderPage(
      <ClipPanel videoId="abcdefghijk" clip={clip as Clip} audio="voice" />,
    );
    await expect.element(page.getByText("87/100")).toBeVisible();
    await expect.element(page.getByText("Lovely light.")).toBeVisible();
    await expect.element(page.getByText("Keeps 1.2 s to 3.5 s")).toBeVisible();
    expect(document.querySelector(".lucide-video")).not.toBeNull();
  });

  it("leaves out the part kept when Director kept the whole take", async () => {
    const [clip] = clipsFor(shots, { 0: { feedback: "All good." } });
    const page = await renderPage(
      <ClipPanel videoId="abcdefghijk" clip={clip as Clip} audio="voice" />,
    );
    await expect.element(page.getByText("All good.")).toBeVisible();
    expect(page.getByText("Keeps", { exact: false }).query()).toBeNull();
    expect(page.getByText("/100", { exact: false }).query()).toBeNull();
  });
});

/** A take in memory, as useTakeMedia keeps it. */
function media(blob: Blob, peaks: number[] | null = null): MediaState {
  const url = URL.createObjectURL(blob);
  return { blob, url, thumbnails: [{ seconds: 0.5, src: url }], peaks };
}

describe("the timeline", () => {
  const script = [
    { startSeconds: 0, endSeconds: 1, text: "Morning." },
    { startSeconds: 1, endSeconds: 2, text: "Coffee first." },
  ];
  const shots = [
    shot({ title: "Walk in", script }),
    shot({ title: "Pour", durationSeconds: 1.5 }),
    shot({ title: "Sip", durationSeconds: 1 }),
    shot({ title: "Look", durationSeconds: 1 }),
    shot({ kind: "photo", title: "Smile", durationSeconds: 1 }),
  ];

  async function timeline(options: {
    soundOn: boolean;
    mediaFor: (index: number) => MediaState | undefined;
  }) {
    const clips = clipsFor(shots, { 0: {}, 1: { status: "reviewing" }, 2: {}, 3: {} });
    const lines = editLines(clips);
    const map = new Map<number, MediaState>();
    for (const clip of clips) {
      const state = options.mediaFor(clip.index);
      if (state) {
        map.set(clip.index, state);
      }
    }
    const scrubs: number[] = [];
    const picked: { clip: number | null; line: string | null } = { clip: null, line: null };
    let setTime: (seconds: number) => void = () => undefined;
    function Timeline() {
      const [time, set] = useState(0);
      const [clip, setClip] = useState<number | null>(null);
      const [line, setLine] = useState<string | null>(null);
      setTime = set;
      return (
        <EditTimeline
          clips={clips}
          lines={lines}
          media={map}
          total={6.5}
          time={time}
          onScrub={(seconds) => scrubs.push(seconds)}
          selectedClip={clip}
          onSelectClip={(each) => {
            picked.clip = each.index;
            setClip(each.index);
          }}
          selectedLine={line}
          onSelectLine={(each) => {
            picked.line = each.key;
            setLine(each.key);
          }}
          soundLabel="Your voice"
          soundOn={options.soundOn}
        />
      );
    }
    const page = await renderPage(<Timeline />);
    return { page, scrubs, picked, setTime: (seconds: number) => setTime(seconds) };
  }

  it("lays the edit out under the playhead: ruler, captions, sound and clips", async () => {
    const video = await recordVideo(1, true);
    const { page, picked } = await timeline({
      soundOn: true,
      mediaFor: (index) => {
        const states: (MediaState | undefined)[] = [
          media(video, [0.2, 1, 0.5]),
          undefined,
          "loading",
          "failed",
          undefined,
        ];
        return states[index];
      },
    });
    const region = page.getByRole("region", { name: "Timeline" });
    await expect.element(region).toBeVisible();
    // A labelled tick every second, to the end rounded up.
    await expect.element(region.getByText("0s", { exact: true })).toBeInTheDocument();
    await expect.element(region.getByText("7s", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Your voice")).toBeVisible();
    // The sound of the clips that have it, as bars.
    expect(document.querySelectorAll("svg[preserveAspectRatio='none'] path")).toHaveLength(1);
    // Each clip: its frames, waiting, failed, or not filmed.
    expect(
      page.getByRole("button", { name: "Shot 1 · Walk in" }).element().querySelector("img")?.src,
    ).toMatch(/^blob:/);
    await expect
      .element(page.getByRole("button", { name: "Shot 2 · Pour" }).getByRole("status"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Shot 3 · Sip" }).getByRole("status"))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Shot 4 · Look" })
        .element()
        .querySelector(".bg-studio-error\\/30"),
    ).not.toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Shot 5 · Smile" }))
      .toHaveTextContent("Film it");

    await userEvent.click(page.getByRole("button", { name: "Shot 4 · Look" }));
    expect(picked.clip).toBe(3);
    await expect
      .element(page.getByRole("button", { name: "Shot 4 · Look" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(page.getByRole("button", { name: "Coffee first." }));
    expect(picked.line).toBe("0:1");
    await expect
      .element(page.getByRole("button", { name: "Coffee first." }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("shows no waveform with the sound off, nor for a take without any", async () => {
    const video = await recordVideo(0.5);
    const { page } = await timeline({ soundOn: false, mediaFor: () => media(video) });
    await expect.element(page.getByText("Your voice")).toBeVisible();
    expect(document.querySelectorAll("svg[preserveAspectRatio='none'] path")).toHaveLength(0);
  });

  it("follows the clock, and scrubs when the member scrolls it", async () => {
    const video = await recordVideo(0.5);
    const { page, scrubs, setTime } = await timeline({
      soundOn: true,
      mediaFor: () => media(video),
    });
    await expect.element(page.getByRole("region", { name: "Timeline" })).toBeVisible();
    const scroller = page.getByRole("region", { name: "Timeline" }).element()
      .firstElementChild as HTMLElement;
    // Half the scroller's width each side, so 0 and the end reach the playhead.
    await expect
      .poll(() => (scroller.querySelector(".shrink-0") as HTMLElement).style.width)
      .toBe(`${scroller.clientWidth / 2}px`);
    setTime(2);
    await expect.poll(() => scroller.scrollLeft).toBe(128);
    // A scroll the clock made isn't a scrub.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scrubs).toEqual([]);
    scroller.scrollLeft = 192;
    await expect.poll(() => scrubs).toEqual([3]);
  });
});

describe("the edit player", () => {
  const shots = [
    shot({
      title: "Walk in",
      durationSeconds: 1.5,
      script: [{ startSeconds: 0, endSeconds: 1, text: "Hi there" }],
    }),
    shot({ kind: "photo", title: "Smile", durationSeconds: 1 }),
    shot({ title: "Wave", durationSeconds: 1 }),
  ];

  async function player(clips: Clip[], map: Map<number, MediaState>) {
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
    const map = new Map<number, MediaState>([
      [0, media(video)],
      [1, media(picture)],
      [2, media(video)],
    ]);
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
    const { update, onStall } = await player(clips, new Map([[0, media(video)]]));
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
    const map = new Map<number, MediaState>(state ? [[0, state]] : []);
    const { page } = await player(clips, map);
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
    const { page, update } = await player(clips, new Map([[1, "loading"]]));
    await expect.element(page.getByText("Shot 1 isn't filmed yet")).toBeVisible();
    update({ time: 1.6 });
    await expect.element(page.getByRole("status")).toBeVisible();
    expect(page.getByText("isn't filmed yet", { exact: false }).query()).toBeNull();
  });
});
