import type { SceneCheck } from "@repo/contracts/api";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { useDirections } from "@/modules/director/hooks/use-directions";
import { renderHook, shot } from "./support";

let speak: MockInstance<SpeechSynthesis["speak"]>;
let cancel: MockInstance<SpeechSynthesis["cancel"]>;
beforeEach(() => {
  speak = vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => undefined);
  cancel = vi.spyOn(window.speechSynthesis, "cancel").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** What Director has said so far, in order. */
const said = () => speak.mock.calls.map(([utterance]) => utterance.text);

const scene = (inPlace: boolean): SceneCheck => ({
  inPlace,
  instruction: "Move about five meters left, to the tree.",
  direction: "left",
  distanceMeters: 5,
  landmark: null,
  lighting: "good",
});

type OnSet = Parameters<typeof useDirections>[0];

const onSet = (overrides: Partial<OnSet> = {}): OnSet => ({
  shot: shot(),
  enabled: true,
  scene: null,
  countdown: null,
  step: undefined,
  recording: false,
  micOn: false,
  ...overrides,
});

describe("useDirections", () => {
  it("says the shot, each direction, the countdown, then each step of the take", async () => {
    const props = onSet();
    const hook = await renderHook(() => useDirections(props));
    await expect.poll(said).toEqual(["Next: The walk-in. Stand by a tree."]);
    expect(speak.mock.calls[0]?.[0].lang).toBe("en");

    const step = (changes: Partial<typeof props>) => {
      Object.assign(props, changes);
      hook.rerender();
    };
    step({ scene: scene(false) });
    step({ scene: scene(true) });
    step({ countdown: 3 });
    step({ countdown: 2 });
    step({ countdown: null, recording: true, step: props.shot.steps[0] });
    await expect
      .poll(said)
      .toEqual([
        "Next: The walk-in. Stand by a tree.",
        "Move about five meters left, to the tree.",
        "Great spot.",
        "3",
        "2",
        "Action!",
        "Walk in from the left",
      ]);
  });

  it("goes quiet for a take that records your voice", async () => {
    const props = onSet({ countdown: 1 });
    const hook = await renderHook(() => useDirections(props));
    await expect.poll(said).toEqual(["Next: The walk-in. Stand by a tree.", "1"]);
    cancel.mockClear();

    Object.assign(props, {
      countdown: null,
      recording: true,
      micOn: true,
      step: props.shot.steps[0],
    });
    hook.rerender();
    await expect.poll(() => cancel).toHaveBeenCalled();
    expect(said()).toEqual(["Next: The walk-in. Stand by a tree.", "1"]);
  });

  it("says nothing with the voice off", async () => {
    const props = onSet({ enabled: false, scene: scene(false), countdown: 3 });
    const hook = await renderHook(() => useDirections(props));
    Object.assign(props, { countdown: null, recording: true, step: props.shot.steps[0] });
    hook.rerender();
    expect(said()).toEqual([]);
  });

  it("stops talking when the screen goes", async () => {
    const hook = await renderHook(() => useDirections(onSet()));
    await expect.poll(said).toHaveLength(1);
    cancel.mockClear();
    hook.unmount();
    expect(cancel).toHaveBeenCalled();
  });
});
