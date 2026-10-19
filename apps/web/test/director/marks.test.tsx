/**
 * Director's marks on the shoot screen: pointing at a thing finds it in the camera's
 * frame (against the contract in memory) and pins a mark there, which follows the
 * camera's motion, is found again on the board's cadence, and goes with a new shot, a
 * flip or a take; and the layer that draws them over the viewfinder.
 */
import { ORPCError } from "@orpc/client";
import type { FrameBox } from "@repo/contracts/api";
import type { Facing } from "@repo/contracts/live";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarksLayer } from "@/modules/director/components/marks-layer";
import { useShotMarks } from "@/modules/director/hooks/use-marks";
import { MARK_LIFETIME_MS, type Mark } from "@/modules/director/lib/marks";
import { renderPage } from "../render";
import { cameraVideo, deferred, renderHook, standIn, until } from "./support";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const box = (x: number, y: number, width = 0.2, height = 0.1): FrameBox => ({
  x,
  y,
  width,
  height,
});

/** The shoot screen's marks, `locate` answering each look for a thing. */
async function shotMarks(
  locate: (
    target: string,
  ) => { found: boolean; box: FrameBox | null } | Promise<{ found: boolean; box: FrameBox | null }>,
  camera: HTMLVideoElement | null = cameraVideo({ width: 720, height: 1280 }),
) {
  const asked: string[] = [];
  const api = standIn((os) => ({
    director: {
      locate: os.director.locate.handler(async ({ input }) => {
        asked.push(input.target);
        return { label: input.target, ...(await locate(input.target)) };
      }),
    },
  }));
  const video = { current: camera };
  const props = { shot: 0, facing: "back" as Facing, setup: true };
  const hook = await renderHook(() => useShotMarks({ video, ...props }), { api });
  const change = (next: Partial<typeof props>) => {
    Object.assign(props, next);
    hook.rerender();
  };
  return { hook, asked, change };
}

describe("pointing at a thing", () => {
  it("pins a mark where it's found, and says when it isn't there or can't be looked for", async () => {
    let found = true;
    const { hook, asked } = await shotMarks(() =>
      found ? { found: true, box: box(0.3, 0.4) } : { found: false, box: null },
    );
    expect(await hook.current.point("m1", "the red mug", "Mug")).toBe("done");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    expect(hook.current.marks[0]).toMatchObject({ id: "m1", label: "Mug", box: box(0.3, 0.4) });
    found = false;
    expect(await hook.current.point("m2", "the window", "Window")).toBe("not_found");
    expect(asked).toEqual(["the red mug", "the window"]);
  });

  it("finds nothing when looking fails, and doesn't look without a picture", async () => {
    const failing = await shotMarks(() => {
      throw new ORPCError("UPSTREAM_UNAVAILABLE");
    });
    expect(await failing.hook.current.point("m1", "the mug", "Mug")).toBe("not_found");
    failing.hook.unmount();
    const dark = await shotMarks(
      () => ({ found: true, box: box(0, 0) }),
      cameraVideo({ width: 0 }),
    );
    expect(await dark.hook.current.point("m1", "the mug", "Mug")).toBe("no_camera");
    dark.hook.unmount();
    const none = await shotMarks(() => ({ found: true, box: box(0, 0) }), null);
    expect(await none.hook.current.point("m1", "the mug", "Mug")).toBe("no_camera");
  });

  it("drops what it found when the shot changed while it looked", async () => {
    const answer = deferred<{ found: boolean; box: FrameBox | null }>();
    const { hook, change } = await shotMarks(() => answer.promise);
    const pointing = hook.current.point("m1", "the mug", "Mug");
    change({ shot: 1 });
    answer.resolve({ found: true, box: box(0.1, 0.1) });
    expect(await pointing).toBe("busy");
    expect(hook.current.marks).toEqual([]);
  });

  it("clears the marks when the camera flips and when a take starts", async () => {
    const { hook, change } = await shotMarks(() => ({ found: true, box: box(0.2, 0.2) }));
    await hook.current.point("m1", "the mug", "Mug");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    change({ facing: "front" });
    await until(() => expect(hook.current.marks).toEqual([]));
    await hook.current.point("m2", "the mug", "Mug");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    change({ setup: false });
    await until(() => expect(hook.current.marks).toEqual([]));
  });
});

describe("a mark on the move", () => {
  it("follows the picture, is found again on its cadence, and fades when it's gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    let place: FrameBox | null = box(0.4, 0.4);
    const { hook, asked } = await shotMarks(() =>
      place ? { found: true, box: place } : { found: false, box: null },
    );
    await hook.current.point("m1", "the mug", "Mug");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    // Four samples a second while a mark shows; 4 s on, it's looked for again.
    place = box(0.5, 0.5);
    vi.advanceTimersByTime(4_250);
    await until(() => expect(asked).toHaveLength(2));
    await until(() => expect(hook.current.marks[0]?.box).toEqual(box(0.5, 0.5)));
    // Gone from the picture: it fades.
    place = null;
    vi.advanceTimersByTime(4_250);
    await until(() => expect(asked).toHaveLength(3));
    await until(() => expect(hook.current.marks[0]?.fadingAt).not.toBeNull());
    vi.advanceTimersByTime(500);
    await until(() => expect(hook.current.marks).toEqual([]));
  });

  it("fades when it can't be looked for again, and stays put with no samples to follow", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    let reachable = true;
    const { hook } = await shotMarks(() => {
      if (!reachable) {
        throw new ORPCError("UPSTREAM_UNAVAILABLE");
      }
      return { found: true, box: box(0.4, 0.4) };
    });
    await hook.current.point("m1", "the mug", "Mug");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    reachable = false;
    // The browser has no canvas for the motion samples: the mark stays where it was.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.advanceTimersByTime(MARK_LIFETIME_MS + 1_000);
    await until(() => expect(hook.current.marks).toEqual([]));
  });
});

describe("a mark when the picture goes", () => {
  it("fades at its next look, with no motion to follow meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    let width = 720;
    const camera = document.createElement("video");
    Object.defineProperty(camera, "videoWidth", { get: () => width });
    Object.defineProperty(camera, "videoHeight", { get: () => (width ? 1280 : 0) });
    const { hook, asked } = await shotMarks(() => ({ found: true, box: box(0.4, 0.4) }), camera);
    await hook.current.point("m1", "the mug", "Mug");
    await until(() => expect(hook.current.marks).toHaveLength(1));
    // The camera's picture is gone (it's being switched): nothing to sample or look in.
    width = 0;
    vi.advanceTimersByTime(4_250);
    await until(() => expect(hook.current.marks[0]?.fadingAt).not.toBeNull());
    expect(asked).toEqual(["the mug"]);
  });
});

describe("the marks layer", () => {
  const mark = (id: string, at: FrameBox, overrides: Partial<Mark> = {}): Mark => ({
    id,
    target: id,
    label: `Label ${id}`,
    box: at,
    foundAt: 0,
    locatedAt: 0,
    drift: 0,
    fadingAt: null,
    ...overrides,
  });

  /** The layer over a viewfinder 360×640 on screen, the camera's frame 720×1280. */
  async function layer(marks: Mark[], camera: HTMLVideoElement | null, mirrored = false) {
    const page = await renderPage(
      <div style={{ position: "relative", width: 360, height: 640 }}>
        <MarksLayer marks={marks} video={{ current: camera }} mirrored={mirrored} />
      </div>,
    );
    return page;
  }

  it("boxes each mark with its label beside it, where there's room", async () => {
    const page = await layer(
      [
        mark("low", box(0.1, 0.5)),
        mark("top", box(0.6, 0.02)),
        mark("whole", box(0, 0, 1, 1)),
        mark("faded", box(0.1, 0.3), { fadingAt: 1 }),
        mark("off", box(0.95, 0.95)),
      ],
      cameraVideo({ width: 720, height: 1280 }),
      true,
    );
    await expect.element(page.getByText("Label low", { exact: true })).toBeInTheDocument();
    const pill = (id: string) =>
      page.getByText(`Label ${id}`, { exact: true }).element().parentElement;
    expect(pill("low")?.className).toContain("bottom-full");
    expect(pill("top")?.className).toContain("top-full");
    expect(pill("whole")?.className).toContain("top-1.5");
    const shown = (id: string) => pill(id)?.parentElement?.getAttribute("aria-hidden");
    expect(shown("low")).toBe("false");
    expect(shown("faded")).toBe("true");
    // Mostly out of the picture: not drawn.
    expect(shown("off")).toBe("true");
  });

  it("waits for the camera's picture before drawing, and draws nothing without a camera", async () => {
    let width = 0;
    const camera = document.createElement("video");
    Object.defineProperty(camera, "videoWidth", { get: () => width });
    Object.defineProperty(camera, "videoHeight", { get: () => (width ? 1280 : 0) });
    const page = await layer([mark("mug", box(0.4, 0.4))], camera);
    expect(page.getByText("Label mug", { exact: true }).query()).toBeNull();
    width = 720;
    camera.dispatchEvent(new Event("loadedmetadata"));
    await expect.element(page.getByText("Label mug", { exact: true })).toBeInTheDocument();

    const none = await layer([mark("cup", box(0.4, 0.4))], null);
    expect(none.getByText("Label cup", { exact: true }).query()).toBeNull();
  });
});
