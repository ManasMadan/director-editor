/** The camera screen's parts: the level, the guides, the capture controls, the prompter. */
import type { SceneCheck } from "@repo/contracts/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { BubbleLevel } from "@/modules/director/components/bubble-level";
import { CaptureBar } from "@/modules/director/components/capture-bar";
import { GuideChips } from "@/modules/director/components/guide-chips";
import { Teleprompter } from "@/modules/director/components/teleprompter";
import type { Phase } from "@/modules/director/hooks/use-studio";
import { renderPage } from "../render";

afterEach(() => {
  vi.restoreAllMocks();
});

const upright = { pitch: 0, roll: 0, tolerance: 6, height: "chest" } as const;

describe("the bubble level", () => {
  it("asks for the tilt where the browser wants a tap first", async () => {
    const onAsk = vi.fn();
    const page = await renderPage(<BubbleLevel tilt={null} target={upright} onAsk={onAsk} />);
    await userEvent.click(page.getByRole("button", { name: "Use the phone's tilt" }));
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it("says it needs a phone when there's no tilt to read", async () => {
    const page = await renderPage(<BubbleLevel tilt={null} target={upright} onAsk={null} />);
    await expect.element(page.getByText("The angle guide works on a phone.")).toBeVisible();
    expect(page.getByRole("img").query()).toBeNull();
  });

  it.each([
    [{ pitch: 2, roll: -3 }, "Angle locked"],
    [{ pitch: -20, roll: 5 }, "Tip the top back"],
    [{ pitch: 20, roll: 5 }, "Tip the top forward"],
    [{ pitch: 0, roll: -12 }, "Lean it right"],
    [{ pitch: 0, roll: 12 }, "Lean it left"],
  ])("guides a phone held at %o: %s", async (tilt, hint) => {
    const page = await renderPage(<BubbleLevel tilt={tilt} target={upright} onAsk={null} />);
    await expect.element(page.getByRole("img", { name: "Phone angle" })).toBeVisible();
    await expect.element(page.getByText(hint)).toBeVisible();
  });

  it("keeps the bubble inside the level however far off the phone is", async () => {
    const page = await renderPage(
      <BubbleLevel tilt={{ pitch: -80, roll: -45 }} target={upright} onAsk={null} />,
    );
    const level = page.getByRole("img", { name: "Phone angle" }).element();
    const [ring, bubble] = level.querySelectorAll("span");
    // The tolerance ring: 6 of 30 degrees.
    expect(ring?.style.inset).toBe("40%");
    expect(bubble?.style.left).toBe("8%");
    expect(bubble?.style.top).toBe("92%");
    expect(bubble?.className).toContain("border-guide-warn");
  });
});

const check = (overrides: Partial<SceneCheck>): SceneCheck => ({
  inPlace: false,
  instruction: "Move about two meters left, to the window.",
  direction: "left",
  distanceMeters: 2,
  landmark: null,
  lighting: "good",
  ...overrides,
});

describe("the guide chips", () => {
  it("shows the scene alone until Director has looked, and no pose guide when it's off", async () => {
    const page = await renderPage(
      <GuideChips
        scene="By a window"
        sceneCheck={null}
        framing={null}
        pose="off"
        poseMatched={false}
      />,
    );
    await expect.element(page.getByText("By a window")).toBeVisible();
    expect(document.querySelectorAll("[aria-live] p")).toHaveLength(1);
  });

  it("gives Director's direction and what's wrong with the light", async () => {
    const page = await renderPage(
      <GuideChips
        scene="By a window"
        sceneCheck={check({ lighting: "too-dark" })}
        framing="step-left"
        pose="loading"
        poseMatched={false}
      />,
    );
    await expect
      .element(page.getByText("Move about two meters left, to the window. · It's too dark here"))
      .toBeVisible();
    await expect.element(page.getByText("Step to your left")).toHaveClass("text-guide-warn");
    await expect.element(page.getByText("Loading the pose guide…")).toBeVisible();
  });

  it("says the spot, the framing and the pose are right", async () => {
    const page = await renderPage(
      <GuideChips
        scene="By a window"
        sceneCheck={check({ inPlace: true })}
        framing="in-frame"
        pose="ready"
        poseMatched
      />,
    );
    await expect.element(page.getByText("Great spot.", { exact: true })).toBeVisible();
    await expect.element(page.getByText("You're in frame")).toHaveClass("text-guide");
    await expect.element(page.getByText("Pose matched")).toHaveClass("text-guide");
  });

  it.each([
    ["ready", "Match the outline"],
    ["failed", "The pose guide couldn't load. You can still film."],
  ] as const)("says what the pose guide needs while it's %s", async (pose, message) => {
    const page = await renderPage(
      <GuideChips
        scene="By a window"
        sceneCheck={null}
        framing={null}
        pose={pose}
        poseMatched={false}
      />,
    );
    await expect.element(page.getByText(message)).toHaveClass("text-guide-warn");
  });
});

function captureBar(phase: Phase, overrides: Partial<Parameters<typeof CaptureBar>[0]> = {}) {
  const handlers = { onRecord: vi.fn(), onStop: vi.fn(), onRetake: vi.fn(), onUse: vi.fn() };
  const ui = (
    <CaptureBar phase={phase} kind="video" ready error={null} {...handlers} {...overrides} />
  );
  return { ui, ...handlers };
}

describe("the capture bar", () => {
  it("records when the camera is ready, and says what went wrong last time", async () => {
    const bar = captureBar("setup", { error: "The camera stopped." });
    const page = await renderPage(bar.ui);
    await expect.element(page.getByRole("alert")).toHaveTextContent("The camera stopped.");
    await userEvent.click(page.getByRole("button", { name: "Record" }));
    expect(bar.onRecord).toHaveBeenCalledOnce();
  });

  it("takes a photo for a photo shot", async () => {
    const bar = captureBar("setup", { kind: "photo" });
    const page = await renderPage(bar.ui);
    await userEvent.click(page.getByRole("button", { name: "Take the photo" }));
    expect(bar.onRecord).toHaveBeenCalledOnce();
    expect(page.getByRole("alert").query()).toBeNull();
  });

  it.each([
    ["setup", false],
    ["countdown", true],
  ] as const)("can't record in %s before the camera is ready", async (phase, ready) => {
    const page = await renderPage(captureBar(phase, { ready }).ui);
    await expect.element(page.getByRole("button", { name: "Record" })).toBeDisabled();
  });

  it("stops a recording", async () => {
    const bar = captureBar("recording");
    const page = await renderPage(bar.ui);
    await userEvent.click(page.getByRole("button", { name: "Stop" }));
    expect(bar.onStop).toHaveBeenCalledOnce();
  });

  it("keeps or redoes a take, and says why sending it failed", async () => {
    const bar = captureBar("preview", { error: "Storage is full." });
    const page = await renderPage(bar.ui);
    await expect.element(page.getByRole("alert")).toHaveTextContent("Storage is full.");
    await userEvent.click(page.getByRole("button", { name: "Retake" }));
    await userEvent.click(page.getByRole("button", { name: "Use this take" }));
    expect(bar.onRetake).toHaveBeenCalledOnce();
    expect(bar.onUse).toHaveBeenCalledOnce();
  });

  it("waits while the take is sent", async () => {
    const page = await renderPage(captureBar("sending").ui);
    await expect
      .element(page.getByRole("button", { name: /Sending your take to Director…$/ }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Retake" })).toBeDisabled();
    expect(page.getByRole("alert").query()).toBeNull();
  });
});

const script = [
  { startSeconds: 0, endSeconds: 1, text: "Morning." },
  { startSeconds: 1, endSeconds: 3, text: "Coffee first." },
  { startSeconds: 3, endSeconds: 4, text: "Then the window." },
];

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
