import type { Shot } from "@repo/contracts/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTilt } from "@/modules/director/hooks/use-tilt";
import { renderHook } from "./support";

// Chromium has the gate too, as iOS Safari does; most browsers have none.
const chromiumGate = Object.getOwnPropertyDescriptor(DeviceOrientationEvent, "requestPermission");
beforeEach(() => {
  Reflect.deleteProperty(DeviceOrientationEvent, "requestPermission");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (chromiumGate) {
    Object.defineProperty(DeviceOrientationEvent, "requestPermission", chromiumGate);
  }
});

const orient = (beta: number | null, gamma: number | null) =>
  window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { beta, gamma }));

/** iOS Safari's gate on the sensor, answering `answer`. */
function gated(answer: () => Promise<"granted" | "denied">) {
  const requestPermission = vi.fn(answer);
  Object.defineProperty(DeviceOrientationEvent, "requestPermission", {
    value: requestPermission,
    configurable: true,
  });
  return requestPermission;
}

describe("useTilt", () => {
  it("reads how the phone is held, in whole degrees, for the shot's camera", async () => {
    let camera: Shot["camera"] = "back";
    const hook = await renderHook(() => useTilt(camera));
    expect(hook.current).toEqual({ tilt: null, ask: null });

    orient(70.4, 5.6);
    await expect.poll(() => hook.current.tilt).toEqual({ pitch: -20, roll: 6 });
    const reading = hook.current.tilt;
    // The same whole degrees: the same reading, so nothing re-renders.
    orient(69.6, 6.4);
    // A reading the sensor can't give yet changes nothing.
    orient(null, 3);
    orient(40, null);
    expect(hook.current.tilt).toBe(reading);

    camera = "front";
    hook.rerender();
    orient(70, 5);
    await expect.poll(() => hook.current.tilt).toEqual({ pitch: 20, roll: 5 });
  });

  it("stops listening when the screen goes", async () => {
    const removed = vi.spyOn(window, "removeEventListener");
    const hook = await renderHook(() => useTilt("back"));
    hook.unmount();
    expect(removed).toHaveBeenCalledWith("deviceorientation", expect.any(Function));
  });

  it("reads nothing on a browser without the sensor", async () => {
    vi.stubGlobal("DeviceOrientationEvent", undefined);
    const hook = await renderHook(() => useTilt("back"));
    expect(hook.current).toEqual({ tilt: null, ask: null });
  });

  it("asks first where the browser needs a tap to allow it", async () => {
    const requestPermission = gated(async () => "granted");
    const hook = await renderHook(() => useTilt("back"));
    orient(90, 0);
    expect(hook.current.tilt).toBeNull();
    expect(hook.current.ask).toBeTypeOf("function");

    await hook.current.ask?.();
    expect(requestPermission).toHaveBeenCalledOnce();
    await expect.poll(() => hook.current.ask).toBeNull();
    orient(90, 0);
    await expect.poll(() => hook.current.tilt).toEqual({ pitch: 0, roll: 0 });
  });

  it("keeps asking after a refusal, or a browser that throws", async () => {
    const requestPermission = gated(async () => "denied");
    const hook = await renderHook(() => useTilt("back"));
    await hook.current.ask?.();
    requestPermission.mockRejectedValue(new Error("not from a tap"));
    await hook.current.ask?.();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(hook.current.ask).toBeTypeOf("function");
    orient(90, 0);
    expect(hook.current.tilt).toBeNull();

    // The gate gone by the time of the tap: nothing to ask.
    Reflect.deleteProperty(DeviceOrientationEvent, "requestPermission");
    await hook.current.ask?.();
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});
