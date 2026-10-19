/**
 * The "tell Director" bar under the editor: Director's answer (Undo when it changed
 * something, takes to choose from when it needs a choice), and a request said out loud.
 */
import type { DirectorShot, DirectorTake, EditorReply } from "@repo/contracts/api";
import { type DirectorTakeId, directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { TellDirector } from "@/modules/director/components/tell-director";
import type { MediaState } from "@/modules/director/hooks/use-take-media";
import { renderPage } from "../render";
import { canvasCamera, recordVideo } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

const takeId = () => directorTakeIdSchema.parse(crypto.randomUUID());

/** A take filmed `second`s into the shoot. */
function filmed(id: DirectorTakeId, second: number): DirectorTake {
  return {
    id,
    shotIndex: 0,
    fileId: fileIdSchema.parse(crypto.randomUUID()),
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: null,
    bestEndMs: null,
    score: null,
    feedback: null,
    reason: null,
    chosen: false,
    origin: "shoot",
    createdAt: new Date(second * 1000),
  };
}

const reply = (overrides: Partial<EditorReply>): EditorReply => ({
  heard: "Warmer please",
  outcome: "answer",
  say: "Done.",
  actions: [],
  choices: [],
  ...overrides,
});

/** The bar as the editor shows it, with what it's handed and each callback a spy. */
async function bar(
  props: {
    reply?: EditorReply | null;
    pending?: boolean;
    error?: unknown;
    shots?: DirectorShot[];
    media?: Map<DirectorTakeId, MediaState>;
  } = {},
) {
  const calls = {
    onSend: vi.fn(),
    onListen: vi.fn(),
    onPick: vi.fn(),
    onUndo: vi.fn(),
    onDismiss: vi.fn(),
  };
  const page = await renderPage(
    <TellDirector
      reply={props.reply ?? null}
      pending={props.pending ?? false}
      error={props.error ?? null}
      shots={props.shots ?? []}
      media={props.media ?? new Map()}
      {...calls}
    />,
  );
  return { page, ...calls };
}

/** The browser's microphone, as a tone: an audio-only stream to record. */
function microphone() {
  return vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(async () => {
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const out = audio.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return out.stream;
  });
}

describe("Director's answer", () => {
  it("offers Undo for a change it made, and goes when dismissed", async () => {
    const { page, onUndo, onDismiss } = await bar({
      reply: reply({
        outcome: "applied",
        say: "Warmer now.",
        actions: [
          {
            op: "drop_shot",
            shotIndex: 1,
            takeId: null,
            otherShotIndex: null,
            position: null,
            startSeconds: null,
            endSeconds: null,
            value: null,
            level: null,
            text: null,
            replacement: null,
            steps: null,
          },
        ],
      }),
    });
    await expect.element(page.getByText("Warmer now.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
    await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("offers no Undo when nothing changed", async () => {
    const { page } = await bar({ reply: reply({ outcome: "applied", say: "Nothing to do." }) });
    await expect.element(page.getByText("Nothing to do.")).toBeVisible();
    expect(page.getByRole("button", { name: "Undo" }).query()).toBeNull();
    expect(page.getByRole("list", { name: "Takes to choose from" }).query()).toBeNull();
  });

  it("shows the takes to choose from, each at its moment, and uses the one tapped", async () => {
    const first = takeId();
    const second = takeId();
    const missing = takeId();
    const blob = await recordVideo(2);
    const url = URL.createObjectURL(blob);
    const { page, onPick } = await bar({
      reply: reply({
        outcome: "ask",
        say: "Which one?",
        choices: [
          { shotIndex: 0, takeId: second, atSeconds: 1.5, note: "brighter" },
          { shotIndex: 0, takeId: first, atSeconds: 0.5, note: "closer" },
          // A shot the edit doesn't list (any more): no number to give its take.
          { shotIndex: 4, takeId: missing, atSeconds: 0, note: "gone" },
        ],
      }),
      shots: [
        {
          index: 0,
          takes: [filmed(second, 2), filmed(first, 1)],
          pickedTakeId: null,
          chosenTakeId: null,
          needsRetake: false,
        },
      ],
      media: new Map<DirectorTakeId, MediaState>([
        [second, { blob, url, poster: url }],
        [first, "loading"],
      ]),
    });
    const choices = page.getByRole("list", { name: "Takes to choose from" });
    await expect.element(choices.getByRole("listitem").first()).toBeVisible();
    expect(choices.getByRole("listitem").elements()).toHaveLength(3);
    const brighter = choices.getByRole("button", { name: "Shot 1, take 2: brighter" });
    await expect.element(brighter).toHaveAttribute("title", "Use this one");
    // The take in memory loops from a moment before the one Director means.
    const video = brighter.element().querySelector("video");
    await expect.poll(() => video?.currentTime).toBeGreaterThanOrEqual(0.5);
    // One still loading shows its place, not a picture.
    const closer = choices.getByRole("button", { name: "Shot 1, take 1: closer" });
    expect(closer.element().querySelector("video")).toBeNull();
    await expect
      .element(choices.getByRole("button", { name: "Shot 5, take 0: gone" }))
      .toBeVisible();
    await userEvent.click(closer);
    expect(onPick).toHaveBeenCalledWith(0, first);
  });

  it("says Director is on it, then why it couldn't answer", async () => {
    const thinking = await bar({ pending: true, error: new Error("offline") });
    await expect.element(thinking.page.getByText("Director's on it…")).toBeVisible();
    // Not while a new request is on its way.
    expect(thinking.page.getByRole("alert").query()).toBeNull();
    const failed = await bar({ error: new Error("offline") });
    await expect.element(failed.page.getByRole("alert")).toBeVisible();
  });
});

describe("a request said out loud", () => {
  it("records until stop, then sends the recording as Director hears it", async () => {
    microphone();
    const { page, onListen, onSend } = await bar();
    await userEvent.click(page.getByRole("button", { name: "Talk to Director" }));
    expect(onListen).toHaveBeenCalledOnce();
    const stop = page.getByRole("button", { name: "Stop and send" });
    await expect.element(stop).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("Listening… tap stop when you're done.")).toBeVisible();
    await userEvent.click(stop);
    await expect
      .poll(() => onSend.mock.calls[0]?.[0])
      .toEqual({ audio: expect.any(String), audioType: "audio/webm" });
    await expect
      .element(page.getByRole("button", { name: "Talk to Director" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("says the microphone isn't there, to type instead", async () => {
    canvasCamera(new DOMException("No microphone.", "NotFoundError"));
    const { page, onSend } = await bar();
    await userEvent.click(page.getByRole("button", { name: "Talk to Director" }));
    await expect
      .element(page.getByText("Your microphone isn't available. Type it instead."))
      .toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends nothing it couldn't record as sound alone, and says so", async () => {
    // A recording with a picture too comes out as a video, which Director doesn't take.
    canvasCamera();
    const { page, onSend } = await bar();
    await userEvent.click(page.getByRole("button", { name: "Talk to Director" }));
    await userEvent.click(page.getByRole("button", { name: "Stop and send" }));
    await expect
      .element(page.getByText("Your microphone isn't available. Type it instead."))
      .toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
  });
});
