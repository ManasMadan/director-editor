/**
 * The shoot screen's pieces on their own: the shot card, the teleprompter, the take
 * review, and the captions drawn over the editor's video.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { CaptionLayer } from "@/modules/director/components/caption-layer";
import { ShotCard } from "@/modules/director/components/shoot-parts";
import { TakeReview } from "@/modules/director/components/take-review";
import { Teleprompter } from "@/modules/director/components/teleprompter";
import { renderPage } from "../render";
import { photo, planShot, recordVideo } from "./support";

let restorePixelRatio: (() => void) | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  restorePixelRatio?.();
  restorePixelRatio = null;
});

const script = [
  { startSeconds: 0, endSeconds: 1, text: "Morning." },
  { startSeconds: 1, endSeconds: 3, text: "Coffee first." },
  { startSeconds: 3, endSeconds: 4, text: "Then the window." },
];

describe("the shot card", () => {
  it("says where, what and the line to say", async () => {
    const page = await renderPage(<ShotCard shot={planShot({ script })} index={0} />);
    await expect.element(page.getByRole("heading", { name: "Shot 1 · Walk in" })).toBeVisible();
    await expect.element(page.getByText("Walk towards the camera.")).toBeVisible();
    await expect.element(page.getByText("“Morning. Coffee first. Then the window.”")).toBeVisible();
  });

  it("shows the whole line to say, however long, on a phone", async () => {
    const long =
      "While travelling around India, I've noticed four variations of the head nod, and it is a whole language of its own once you know how to read it.";
    const page = await renderPage(
      <div style={{ width: 360 }}>
        <ShotCard
          shot={planShot({ script: [{ startSeconds: 0, endSeconds: 9, text: long }] })}
          index={0}
        />
      </div>,
    );
    const say = page.getByText(`“${long}”`);
    await expect.element(say).toBeVisible();
    // Nothing of it is cut off: it's what the member has to say.
    const element = say.element();
    expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight);
  });

  it("falls back on the pose without steps, and leaves out Say without lines", async () => {
    const shot = planShot({
      steps: [],
      script: [],
      pose: { description: "Arms crossed.", keypoints: [] },
    });
    const page = await renderPage(<ShotCard shot={shot} index={2} />);
    await expect.element(page.getByRole("heading", { name: "Shot 3 · Walk in" })).toBeVisible();
    await expect.element(page.getByText("Arms crossed.")).toBeVisible();
    expect(page.getByText("Say").query()).toBeNull();
  });
});

describe("the teleprompter", () => {
  it("lights the line to say now, swept as it's said, fading the ones said", async () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const page = await renderPage(<Teleprompter script={script} seconds={1.5} />);
    const lines = page.getByRole("region", { name: "Teleprompter" }).getByRole("listitem");
    await expect.element(lines.nth(1)).toHaveAttribute("aria-current", "true");
    await expect.element(lines.nth(0)).toHaveClass("opacity-30");
    await expect.element(lines.nth(2)).toHaveClass("opacity-60");
    const sweep = lines.nth(1).element().querySelector("span");
    expect(sweep?.style.backgroundPosition).toBe("75% 0px");
    expect(scrolled.mock.contexts[0]).toBe(lines.nth(1).element());
  });

  it("leaves every line waiting once they're all said", async () => {
    const page = await renderPage(<Teleprompter script={script} seconds={9} />);
    const lines = page.getByRole("listitem");
    await expect.element(lines.nth(0)).toHaveClass("opacity-60");
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  it("shows nothing for a shot without lines", async () => {
    const page = await renderPage(<Teleprompter script={[]} seconds={0} />);
    expect(page.getByRole("region", { name: "Teleprompter" }).query()).toBeNull();
  });
});

const actions = () => ({ onAgain: vi.fn(), onKeep: vi.fn() });

describe("the take review", () => {
  it("loops the take with its sound, and goes again or keeps it", async () => {
    const take = await recordVideo(0.4, true);
    const choose = actions();
    const page = await renderPage(
      <TakeReview
        take={take}
        script={script}
        sending={false}
        error={null}
        captions={null}
        tell={null}
        {...choose}
      />,
    );
    const video = page.getByLabelText("Your take, on loop");
    await expect.element(video).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    await expect
      .poll(() => video.element().querySelector("track")?.getAttribute("src"))
      .toMatch(/^blob:/);
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
      <TakeReview
        take={take}
        script={script}
        sending={false}
        error={null}
        captions={null}
        tell={null}
        {...actions()}
      />,
    );
    await expect.poll(() => play.mock.calls.length).toBe(2);
    expect((document.querySelector("video") as HTMLVideoElement).muted).toBe(true);
  });

  it("shows a photo, says why it couldn't be sent, and waits while it's sent", async () => {
    const page = await renderPage(
      <TakeReview
        take={await photo()}
        script={script}
        sending
        error="Couldn't send it."
        captions={null}
        tell={null}
        {...actions()}
      />,
    );
    await expect
      .element(page.getByRole("img", { name: "Your photo" }))
      .toHaveAttribute("src", expect.stringMatching(/^blob:/));
    await expect.element(page.getByRole("alert")).toHaveTextContent("Couldn't send it.");
    await expect.element(page.getByRole("button", { name: /Keep it/ })).toBeDisabled();
    await expect
      .element(page.getByRole("status", { name: "Sending your take to Director…" }))
      .toBeInTheDocument();
  });
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

function Viewfinder({ children }: { children: React.ReactNode }) {
  return <div style={{ position: "relative", width: 180, height: 320 }}>{children}</div>;
}

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

  it("are drawn again only when what they show changes, not every frame", async () => {
    let now = 0.1;
    const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, "fillText");
    await renderPage(
      <Viewfinder>
        <CaptionLayer lines={lines} style="pop" clock={() => now} />
      </Viewfinder>,
    );
    await expect.poll(drawn).toBe(true);
    const once = fillText.mock.calls.length;
    await frames();
    await frames();
    expect(fillText.mock.calls.length).toBe(once);
    // The second word lights up: drawn again.
    now = 4.9;
    await expect.poll(() => fillText.mock.calls.length).toBeGreaterThan(once);
  });

  it("leave the video alone where the browser has no 2D canvas", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
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
