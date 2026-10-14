/**
 * What Director shows over a picture: the doodles over the camera, redrawn every frame at
 * the canvas's own size, and the Director's Cut over a take just recorded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { CaptionLayer } from "@/modules/director/components/caption-layer";
import { DirectorsCut } from "@/modules/director/components/directors-cut";
import { DoodleLayer } from "@/modules/director/components/doodle-layer";
import type { Cut } from "@/modules/director/lib/cut";
import type { DoodleScene } from "@/modules/director/lib/doodle";
import { renderPage } from "../render";
import { photo, planShot, recordVideo } from "./support";

let restorePixelRatio: (() => void) | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  restorePixelRatio?.();
  restorePixelRatio = null;
});

/** A screen that reports no pixel ratio at all. */
function noPixelRatio() {
  const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { value: 0, configurable: true });
  restorePixelRatio = () => {
    if (own) {
      Object.defineProperty(window, "devicePixelRatio", own);
    } else {
      Reflect.deleteProperty(window, "devicePixelRatio");
    }
  };
}

/** A browser that can't give the page a 2D canvas. */
function no2dCanvas() {
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}

/** The next two animation frames: a canvas drawing every frame has drawn by then. */
const frames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const canvas = () => document.querySelector("canvas") as HTMLCanvasElement;

/** Whether anything has been drawn on the canvas. */
const drawn = () => {
  const ctx = canvas().getContext("2d") as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, canvas().width, canvas().height);
  return data.some((value, at) => at % 4 === 3 && value > 0);
};

const scene: DoodleScene = {
  shot: planShot(),
  target: {},
  matched: false,
  mirrored: false,
  person: null,
  framing: null,
  scene: null,
  move: null,
  recording: false,
  subject: true,
  still: false,
  horizon: null,
  highlights: [],
  stickers: [],
  labels: { spot: "Stand here", meters: null, move: null },
};

function Viewfinder({ children }: { children: React.ReactNode }) {
  return <div style={{ position: "relative", width: 180, height: 320 }}>{children}</div>;
}

describe("the doodles", () => {
  it("are drawn at the canvas's size, even on a screen with no pixel ratio", async () => {
    noPixelRatio();
    await renderPage(
      <Viewfinder>
        <DoodleLayer scene={scene} />
      </Viewfinder>,
    );
    await expect.poll(() => canvas().width).toBe(180);
    expect(canvas().height).toBe(320);
    await expect.poll(drawn).toBe(true);
  });

  it("leave the camera alone where the browser has no 2D canvas", async () => {
    const getContext = no2dCanvas();
    await renderPage(
      <Viewfinder>
        <DoodleLayer scene={scene} />
      </Viewfinder>,
    );
    await expect.poll(() => getContext.mock.calls.length).toBeGreaterThan(0);
    await frames();
    // Never sized, so never drawn on.
    expect(canvas().width).toBe(300);
  });
});

const script = [{ startSeconds: 0, endSeconds: 5, text: "Coffee first." }];

describe("the captions over a video", () => {
  const lines = [{ key: "0", startSeconds: 0, endSeconds: 5, text: "Coffee first." }];

  it("are drawn at the canvas's size, even on a screen with no pixel ratio", async () => {
    noPixelRatio();
    await renderPage(
      <Viewfinder>
        <CaptionLayer lines={lines} style="pop" clock={() => 1} />
      </Viewfinder>,
    );
    await expect.poll(() => canvas().width).toBe(180);
    await expect.poll(drawn).toBe(true);
  });

  it("leave the video alone where the browser has no 2D canvas", async () => {
    const getContext = no2dCanvas();
    await renderPage(
      <Viewfinder>
        <CaptionLayer lines={lines} style="pop" clock={() => 1} />
      </Viewfinder>,
    );
    await expect.poll(() => getContext.mock.calls.length).toBeGreaterThan(0);
    await frames();
    expect(canvas().width).toBe(300);
  });
});

const cut = (overrides: Partial<Cut> = {}): Cut => ({
  startSeconds: 0.2,
  endSeconds: 0.4,
  score: 87,
  praise: "framing",
  tip: "energy",
  lateStart: false,
  ...overrides,
});

const actions = () => ({ onAgain: vi.fn(), onKeep: vi.fn() });

describe("the Director's Cut", () => {
  it("loops the take's best stretch, captioned, with the score, the praise and the tip", async () => {
    const take = await recordVideo(0.6, true);
    const choose = actions();
    const page = await renderPage(
      <DirectorsCut
        take={take}
        cut={cut()}
        script={script}
        sending={false}
        error={null}
        {...choose}
      />,
    );
    const video = page.getByLabelText("Best moment, on loop");
    await expect.element(video).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    await expect
      .poll(() => video.element().querySelector("track")?.getAttribute("src"))
      .toMatch(/^blob:/);
    await expect
      .element(page.getByRole("img", { name: "Director's score: 87 out of 100" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Framing was spot-on!")).toBeInTheDocument();
    await expect.element(page.getByText(/more energy/)).toBeInTheDocument();
    // Round the loop: past its end it goes back to its start.
    const element = video.element() as HTMLVideoElement;
    await expect.poll(() => element.readyState).toBeGreaterThan(0);
    element.currentTime = 0.5;
    element.dispatchEvent(new Event("timeupdate"));
    await expect.poll(() => element.currentTime).toBeCloseTo(0.2, 1);
    element.dispatchEvent(new Event("ended"));
    await userEvent.click(page.getByRole("button", { name: "Go again" }));
    await userEvent.click(page.getByRole("button", { name: "Keep it" }));
    expect([choose.onAgain.mock.calls.length, choose.onKeep.mock.calls.length]).toEqual([1, 1]);
  });

  it("plays silently where the browser won't play the sound by itself", async () => {
    const take = await recordVideo(0.3);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("No sound yet", "NotAllowedError"))
      .mockResolvedValue(undefined);
    await renderPage(
      <DirectorsCut
        take={take}
        cut={cut()}
        script={script}
        sending={false}
        error={null}
        {...actions()}
      />,
    );
    await expect.poll(() => play.mock.calls.length).toBe(2);
    expect((document.querySelector("video") as HTMLVideoElement).muted).toBe(true);
  });

  it("shows a photo, with nothing to fix, and waits while it's sent", async () => {
    const page = await renderPage(
      <DirectorsCut
        take={await photo()}
        cut={cut({ tip: null, praise: "light" })}
        script={script}
        sending
        error="Couldn't send it."
        {...actions()}
      />,
    );
    await expect
      .element(page.getByRole("img", { name: "Director's cut" }))
      .toHaveAttribute("src", expect.stringMatching(/^blob:/));
    await expect.element(page.getByText("Nothing to fix. Ship it!")).toBeInTheDocument();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't send it.");
    await expect.element(page.getByRole("button", { name: /Keep it/ })).toBeDisabled();
  });
});
