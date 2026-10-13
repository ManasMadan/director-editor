/**
 * What Director draws on canvases over a picture: the doodles over the camera, and a
 * take's captions over its preview, each redrawn every frame at the canvas's own size.
 */
import { useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoodleLayer } from "@/modules/director/components/doodle-layer";
import { TakePreview } from "@/modules/director/components/take-preview";
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

describe("a take's preview", () => {
  it("plays the video take with its script captioned over it", async () => {
    noPixelRatio();
    const take = await recordVideo(0.5);
    const page = await renderPage(
      <Viewfinder>
        <TakePreview take={take} label="Your take" script={script} lang="en" />
      </Viewfinder>,
    );
    const video = page.getByLabelText("Your take");
    await expect.element(video).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    const track = video.element().querySelector("track");
    await expect.poll(() => track?.getAttribute("src")).toMatch(/^blob:/);
    expect(track?.getAttribute("srclang")).toBe("en");
    await expect.poll(() => canvas().width).toBe(180);
    await expect.poll(drawn).toBe(true);
  });

  it("shows a photo take as the picture", async () => {
    const page = await renderPage(
      <TakePreview take={await photo()} label="Your take" script={script} lang="en" />,
    );
    await expect
      .element(page.getByRole("img", { name: "Your take" }))
      .toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(canvas()).toBeNull();
  });

  it("shows the take without captions where the browser has no 2D canvas", async () => {
    const take = await recordVideo(0.3);
    const getContext = no2dCanvas();
    const page = await renderPage(
      <TakePreview take={take} label="Your take" script={script} lang="en" />,
    );
    await expect.element(page.getByLabelText("Your take")).toBeInTheDocument();
    await expect.poll(() => getContext.mock.calls.length).toBeGreaterThan(0);
    await frames();
    expect(canvas().width).toBe(300);
  });

  it("keeps drawing safely while the preview is taken down", async () => {
    const take = await recordVideo(0.3);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    let hide: () => void = () => undefined;
    function Preview() {
      const [shown, setShown] = useState(true);
      hide = () => setShown(false);
      // The commit takes a frame's time, so the captions' next frame comes before React
      // has stopped them: the take's video is already gone when they read its time.
      useLayoutEffect(() => {
        if (!shown) {
          const until = performance.now() + 50;
          while (performance.now() < until) {
            // Busy, as a slow phone is.
          }
        }
      }, [shown]);
      return shown ? (
        <Viewfinder>
          <TakePreview take={take} label="Your take" script={script} lang="en" />
        </Viewfinder>
      ) : null;
    }
    const page = await renderPage(<Preview />);
    await expect.element(page.getByLabelText("Your take")).toBeInTheDocument();
    // The captions are drawing, frame after frame.
    await expect.poll(() => canvas().width).toBe(180);
    hide();
    await expect.element(page.getByLabelText("Your take")).not.toBeInTheDocument();
    await frames();
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
  });
});
