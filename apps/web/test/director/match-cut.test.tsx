/**
 * Match cuts: the editor's note on each one (lining up, aligned, or a plain cut) with
 * "Check the cut", the hook that asks Director to line them up, and the shoot screen's
 * ghost of the shot before. Against the API's contract in memory.
 */
import { ORPCError } from "@orpc/client";
import { ApiProvider } from "@repo/client";
import type { DirectorShot, DirectorTake, MatchCutAlignment, Shot } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page as browserPage, commands, userEvent } from "vitest/browser";
import { MatchCutNotes } from "@/modules/director/components/match-cut";
import { MatchGhost } from "@/modules/director/components/match-ghost";
import { type MatchCutState, useMatchCuts } from "@/modules/director/hooks/use-match-cuts";
import { clipsOf } from "@/modules/director/lib/edit";
import type { MatchCut } from "@/modules/director/lib/match-cuts";
import { base64Of } from "@/modules/director/lib/media";
import { cleanup, renderPage } from "../render";
import { deferred, planShot, recordVideo, renderHook, standIn } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

const VIDEO_ID = videoIdSchema.parse("dQw4w9WgXcQ");
const ANCHOR = "the watch on the left wrist";
// A 1×1 PNG, as a frame the service drew.
const FRAME =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const cut = (into: number): MatchCut => ({
  into,
  anchor: ANCHOR,
  ask: {
    videoId: VIDEO_ID,
    anchor: ANCHOR,
    outgoing: { takeId: directorTakeIdSchema.parse(crypto.randomUUID()), atMs: 1800 },
    incoming: { takeId: directorTakeIdSchema.parse(crypto.randomUUID()), atMs: 300 },
  },
});

const aligned = (overrides: Partial<MatchCutAlignment> = {}): MatchCutAlignment => ({
  status: "aligned",
  outgoingEndMs: 1800,
  incomingStartMs: 300,
  transform: { x: -40, y: 25, scale: 0.95, rotation: -2 },
  offsetBeforePx: 61.4,
  offsetPx: 1.5,
  scaleDiff: 0.002,
  rotationDiff: 0.1,
  cropPercent: 7,
  withinTolerance: true,
  anchor: { x: 0.25, y: 0.5 },
  outgoingFrame: FRAME,
  incomingFrame: FRAME,
  ...overrides,
});

describe("the editor's match cut notes", () => {
  it("say nothing without a match cut", async () => {
    const page = await renderPage(<MatchCutNotes cuts={[]} />);
    expect(page.getByText(/cut into shot/).query()).toBeNull();
  });

  it("say each cut is lining up, couldn't be, or is a plain cut", async () => {
    const page = await renderPage(
      <MatchCutNotes
        cuts={[
          { cut: cut(1), step: "aligning" },
          { cut: cut(2), step: "failed" },
          { cut: cut(3), step: "done", alignment: aligned({ status: "not-found" }) },
        ]}
      />,
    );
    await expect
      .element(page.getByText(`Lining up the cut into shot 2 on ${ANCHOR}…`))
      .toBeVisible();
    await expect
      .element(page.getByText("Couldn't line up the cut into shot 3. It plays as a plain cut."))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          `Couldn't spot ${ANCHOR} either side of the cut into shot 4, so it's a plain cut.`,
        ),
      )
      .toBeVisible();
    expect(page.getByRole("button", { name: "Check the cut" }).query()).toBeNull();
  });

  it("show an aligned cut's frames laid over, the crosshair on the anchor, and how far it moves", async () => {
    const page = await renderPage(
      <MatchCutNotes cuts={[{ cut: cut(1), step: "done", alignment: aligned() }]} />,
    );
    await expect.element(page.getByText("Aligned for you")).toBeVisible();
    await expect
      .element(page.getByText(`${ANCHOR} stays put into shot 2: 2 px off at the cut (was 61 px).`))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Check the cut" }));
    const dialog = page.getByRole("dialog", { name: "The cut into shot 2" });
    await expect
      .element(dialog.getByRole("img", { name: "Last frame before the cut" }))
      .toBeVisible();
    await expect
      .element(dialog.getByRole("img", { name: "First frame after the cut, aligned" }))
      .toHaveAttribute("src", `data:image/jpeg;base64,${FRAME}`);
    const crosshair = dialog.element().querySelector<SVGElement>("svg.lucide-crosshair");
    expect(crosshair?.style.left).toBe("25%");
    await expect.element(dialog.getByText("Moves 2 px at the cut")).toBeVisible();
    await expect.element(dialog.getByText("Within the 8 px it may move")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Done" }));
    await expect.poll(() => browserPage.getByRole("dialog").query()).toBeNull();
  });

  it("check a cut with no frames to show, and no anchor found to mark", async () => {
    const page = await renderPage(
      <MatchCutNotes
        cuts={[
          {
            cut: cut(1),
            step: "done",
            alignment: aligned({
              outgoingFrame: null,
              anchor: null,
              offsetPx: 12,
              withinTolerance: false,
            }),
          },
        ]}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: "Check the cut" }));
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByText("More than the 8 px it may move: try another take"))
      .toBeVisible();
    expect(dialog.getByRole("img").query()).toBeNull();
    cleanup();
    await renderPage(
      <MatchCutNotes
        cuts={[{ cut: cut(1), step: "done", alignment: aligned({ anchor: null }) }]}
      />,
    );
    await userEvent.click(browserPage.getByRole("button", { name: "Check the cut" }));
    await expect
      .element(browserPage.getByRole("img", { name: "Last frame before the cut" }))
      .toBeVisible();
    expect(
      browserPage.getByRole("dialog").element().querySelector("svg.lucide-crosshair"),
    ).toBeNull();
  });
});

const shot = (sourceStartSeconds: number): Shot =>
  planShot({ sourceStartSeconds, sourceEndSeconds: sourceStartSeconds + 2, durationSeconds: 2 });

const watch = (startSeconds: number) => ({
  type: "transition",
  startSeconds,
  endSeconds: startSeconds + 0.1,
  transition: "match-cut",
  anchor: ANCHOR,
});

function take(shotIndex: number, overrides: Partial<DirectorTake> = {}): DirectorTake {
  return {
    id: directorTakeIdSchema.parse(crypto.randomUUID()),
    shotIndex,
    fileId: fileIdSchema.parse(crypto.randomUUID()),
    kind: "video",
    status: "ready",
    error: null,
    bestStartMs: 0,
    bestEndMs: 1500,
    score: 80,
    feedback: null,
    reason: null,
    chosen: false,
    origin: "shoot",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("lining up the edit's match cuts", () => {
  it("asks about each one, and applies what came back as it comes", async () => {
    const plan = {
      shots: [shot(0), shot(2), shot(4), shot(6)],
      edits: [watch(2), watch(4), watch(6)],
    };
    const clips = clipsOf(
      plan.shots,
      new Map([
        [0, take(0)],
        [1, take(1)],
        [2, take(2)],
        [3, take(3)],
      ]),
    );
    const later = deferred<MatchCutAlignment>();
    const api = standIn((os) => ({
      director: {
        alignMatchCut: os.director.alignMatchCut.handler(({ input }) => {
          if (input.incoming.takeId === clips[1]?.take?.id) {
            return aligned();
          }
          if (input.incoming.takeId === clips[2]?.take?.id) {
            throw new ORPCError("UPSTREAM_UNAVAILABLE");
          }
          return later.promise;
        }),
      },
    }));
    const hook = await renderHook(() => useMatchCuts(VIDEO_ID, plan, clips), { api });
    const steps = () => hook.current.cuts.map((state: MatchCutState) => state.step);
    await expect.poll(steps).toEqual(["done", "failed", "aligning"]);
    // The aligned cut moves its clips' cut points, and draws the incoming clip moved.
    expect(hook.current.clips[1]?.from).toBe(0.3);
    expect(hook.current.transforms.get(1)).toEqual(aligned().transform);
    later.resolve(aligned({ status: "not-found" }));
    await expect.poll(steps).toEqual(["done", "failed", "done"]);
    expect([...hook.current.transforms.keys()]).toEqual([1]);
  });
});

describe("the ghost of the shot before", () => {
  const plan = { shots: [shot(0), shot(2)], edits: [watch(2)] };
  // The take in storage: a WebM recorded in the page, as the take recorder makes one (no
  // duration written in it), recorded once for every test.
  let recorded: Promise<string> | undefined;
  const footage = () => {
    recorded ??= recordVideo(1).then(base64Of);
    return recorded;
  };

  /** The ghost over shot `index`, the shots as Director lists them, the take's file served. */
  async function ghost(
    shots: DirectorShot[],
    {
      index = 1,
      facing = "back",
      storage = 200,
    }: { index?: number; facing?: "front" | "back"; storage?: number } = {},
  ) {
    if (storage === 200) {
      await commands.serveRequests("^https://storage\\.test/", {
        contentType: "video/webm",
        base64: await footage(),
      });
    } else {
      await commands.failRequests("storage.test", { status: storage });
    }
    const api = standIn((os) => ({
      director: { shots: os.director.shots.handler(() => shots) },
      files: {
        downloadUrl: os.files.downloadUrl.handler(({ input }) => ({
          url: `https://storage.test/${input.fileId}`,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      },
    }));
    const page = await renderPage(
      <ApiProvider options={{ baseUrl: "http://api.test", fetch: api.fetch }}>
        <MatchGhost videoId={VIDEO_ID} plan={plan} index={index} facing={facing} />
      </ApiProvider>,
    );
    return { page, api };
  }

  const listed = (takes: DirectorTake[], pickedTakeId: DirectorTake["id"] | null = null) => [
    { index: 0, takes, pickedTakeId, chosenTakeId: null, needsRetake: false },
    { index: 1, takes: [], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
  ];

  it("lays the picked take's last kept frame over the camera, mirrored like the front camera", async () => {
    const picked = take(0, { bestEndMs: 800 });
    const { page } = await ghost(
      listed(
        [take(0), picked, take(0, { kind: "photo" }), take(0, { status: "reviewing" })],
        picked.id,
      ),
      { facing: "front" },
    );
    const frame = page.getByRole("img", {
      name: "The last frame of the shot before, to line up with",
    });
    await expect.element(frame).toHaveAttribute("src", expect.stringMatching(/^data:image\/jpeg/));
    expect(frame.element().className).toContain("-scale-x-100");
    await expect.element(page.getByText(`Line up ${ANCHOR} with the faint picture`)).toBeVisible();
  });

  it("takes the newest filmed take to its end when none is picked", async () => {
    const { page } = await ghost(listed([take(0, { bestEndMs: null })]));
    const frame = page.getByRole("img", {
      name: "The last frame of the shot before, to line up with",
    });
    await expect.element(frame).toBeVisible();
    expect(frame.element().className).not.toContain("-scale-x-100");
  });

  it("isn't there for a cut that isn't a match cut, a shot before with no take, or a frame it can't get", async () => {
    // The first shot has no cut into it: nothing is even asked.
    const first = await ghost(listed([]), { index: 0 });
    expect(first.api.calls).toEqual([]);
    expect(first.page.getByRole("img").query()).toBeNull();
    cleanup();
    // The shot before was only photographed: no frame of it to show.
    const photographed = await ghost(listed([take(0, { kind: "photo" })]));
    await expect.poll(() => photographed.api.calls).toEqual(["director/shots"]);
    expect(photographed.page.getByRole("img").query()).toBeNull();
    cleanup();
    // Storage won't give the take.
    await ghost(listed([take(0)]), { storage: 404 });
    await expect.poll(() => commands.failedRequests("storage.test")).toBe(1);
    expect(browserPage.getByRole("img").query()).toBeNull();
  });

  it("isn't there when the browser has no canvas to draw the frame on", async () => {
    // The take is recorded first: it's drawn on a canvas too.
    await footage();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await ghost(listed([take(0)]));
    await expect.poll(() => getContext.mock.calls.length).toBeGreaterThan(0);
    expect(browserPage.getByRole("img").query()).toBeNull();
  });

  it("keeps the ghost of the shot it's on when the one it left lands late", async () => {
    await commands.serveRequests("^https://storage\\.test/", {
      contentType: "video/webm",
      base64: await footage(),
    });
    const first = take(0);
    const second = take(1);
    const late = deferred<void>();
    const api = standIn((os) => ({
      director: {
        shots: os.director.shots.handler(() => [
          { index: 0, takes: [first], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
          { index: 1, takes: [second], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
          { index: 2, takes: [], pickedTakeId: null, chosenTakeId: null, needsRetake: false },
        ]),
      },
      files: {
        downloadUrl: os.files.downloadUrl.handler(async ({ input }) => {
          if (input.fileId === second.fileId) {
            await late.promise;
          }
          return {
            url: `https://storage.test/${input.fileId}`,
            expiresAt: new Date(Date.now() + 60_000),
          };
        }),
      },
    }));
    const threeShots = { shots: [shot(0), shot(2), shot(4)], edits: [watch(2), watch(4)] };
    function Shoot() {
      // On shot 3 first, its ghost (shot 2's take) slow to come; then back on shot 2.
      const [index, setIndex] = useState(2);
      return (
        <>
          <button type="button" onClick={() => setIndex(1)}>
            Back a shot
          </button>
          <MatchGhost videoId={VIDEO_ID} plan={threeShots} index={index} facing="back" />
        </>
      );
    }
    const page = await renderPage(
      <ApiProvider options={{ baseUrl: "http://api.test", fetch: api.fetch }}>
        <Shoot />
      </ApiProvider>,
    );
    await expect.poll(() => api.calls).toContain("files/downloadUrl");
    await userEvent.click(page.getByRole("button", { name: "Back a shot" }));
    const ghostImage = page.getByRole("img", {
      name: "The last frame of the shot before, to line up with",
    });
    await expect.element(ghostImage).toBeVisible();
    // Each frame drawn is read off its canvas once: the late one is the second.
    const drawn = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    late.resolve();
    await expect.poll(() => drawn.mock.calls.length).toBe(1);
    // The late frame is the shot it left's: it doesn't take this one's place.
    await expect.element(ghostImage).toBeVisible();
  });
});
