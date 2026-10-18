import type { QueuedItem } from "@repo/client/api/recording/slice-store";
import { recordingSessionIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { type PartRecorder, Roll, type RollApi, SLICE_MS } from "./roll";

const SESSION = recordingSessionIdSchema.parse("6b1d3a52-8d1e-4c3b-9a55-2f1e7c9d0a11");
const stream = {} as MediaStream;

/** A recorder that hands over what the test says, when it says. */
class FakeRecorder implements PartRecorder {
  current: "inactive" | "recording" | "paused" = "inactive";
  timeslice = 0;
  constructor(readonly events: { onData: (bytes: Blob) => void; onStop: () => void }) {}
  state() {
    return this.current;
  }
  start(timeslice: number) {
    this.timeslice = timeslice;
    this.current = "recording";
  }
  pause() {
    this.current = "paused";
  }
  resume() {
    this.current = "recording";
  }
  stop() {
    this.current = "inactive";
    this.events.onData(new Blob(["last"]));
    this.events.onStop();
  }
  /** The browser stopped it by itself (the tab hidden). */
  kill() {
    this.current = "inactive";
    this.events.onData(new Blob(["tail"]));
    this.events.onStop();
  }
}

function setup(overrides: Partial<RollApi> = {}, canRecord = true) {
  let clock = 0;
  const queued: QueuedItem[] = [];
  const recorders: FakeRecorder[] = [];
  const api = {
    start: vi.fn<RollApi["start"]>(() => Promise.resolve({ id: SESSION })),
    addPart: vi.fn<RollApi["addPart"]>(() => Promise.resolve({})),
    pause: vi.fn<RollApi["pause"]>(() => Promise.resolve({})),
    resume: vi.fn<RollApi["resume"]>(() => Promise.resolve({})),
    mark: vi.fn<RollApi["mark"]>(() => Promise.resolve({})),
    finish: vi.fn<RollApi["finish"]>(() => Promise.resolve({})),
    ...overrides,
  };
  const onChange = vi.fn();
  const roll = new Roll({
    api,
    enqueue: async (item) => {
      queued.push(item);
    },
    record: (_stream, events) => {
      if (!canRecord) {
        return null;
      }
      const recorder = new FakeRecorder(events);
      recorders.push(recorder);
      return recorder;
    },
    contentType: "video/webm",
    now: () => clock,
    onChange,
  });
  return {
    roll,
    api,
    queued,
    recorders,
    onChange,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const slices = (queued: QueuedItem[]) =>
  queued.map((item) =>
    item.kind === "slice"
      ? [item.partIndex, item.index, item.startMs, item.durationMs]
      : ["end", item.partIndex, item.sliceCount],
  );

describe("the roll", () => {
  it("records the whole shoot in ten-second slices, on the recording's own clock", async () => {
    const { roll, api, queued, recorders, tick, onChange } = setup();
    expect(await roll.start("abcdefghijk", stream, "front")).toBe(true);
    expect(roll.phase).toBe("recording");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(api.start).toHaveBeenCalledWith({ videoId: "abcdefghijk" });
    expect(api.addPart).toHaveBeenCalledWith({
      sessionId: SESSION,
      index: 0,
      camera: "front",
      contentType: "video/webm",
    });
    const recorder = recorders[0];
    expect(recorder?.timeslice).toBe(SLICE_MS);
    tick(10_000);
    recorder?.events.onData(new Blob(["a"]));
    // An empty hand-over is nothing to send.
    recorder?.events.onData(new Blob([]));
    tick(4_000);
    expect(roll.elapsedMs()).toBe(14_000);
    // Starting twice does nothing.
    expect(await roll.start("abcdefghijk", stream, "front")).toBe(false);
    await roll.done();
    expect(roll.phase).toBe("done");
    expect(slices(queued)).toEqual([
      [0, 0, 0, 10_000],
      [0, 1, 10_000, 4_000],
      ["end", 0, 2],
    ]);
    expect(api.finish).toHaveBeenCalledWith({ sessionId: SESSION });
    expect(roll.elapsedMs()).toBe(14_000);
    // Done twice does nothing.
    await roll.done();
    expect(api.finish).toHaveBeenCalledTimes(1);
  });

  it("pauses the clock, and marks only while it records", async () => {
    const { roll, api, recorders, tick } = setup();
    expect(await roll.mark("start", 0, {})).toBe("not_recording");
    await roll.start("abcdefghijk", stream, "front");
    tick(2_000);
    expect(await roll.mark("start", 1, { line: "Hi!" })).toBe("done");
    expect(api.mark).toHaveBeenCalledWith({
      sessionId: SESSION,
      partIndex: 0,
      atMs: 2_000,
      event: "start",
      shotIndex: 1,
      line: "Hi!",
    });
    roll.pause();
    expect(roll.phase).toBe("paused");
    expect(recorders[0]?.current).toBe("paused");
    expect(api.pause).toHaveBeenCalledWith({ sessionId: SESSION, partIndex: 0, atMs: 2_000 });
    tick(30_000);
    expect(await roll.mark("end", 1, {})).toBe("paused");
    // Pausing twice does nothing.
    roll.pause();
    expect(api.pause).toHaveBeenCalledTimes(1);
    await roll.resume(stream, "front");
    expect(recorders[0]?.current).toBe("recording");
    expect(api.resume).toHaveBeenCalledWith({ sessionId: SESSION, partIndex: 0, atMs: 2_000 });
    tick(1_000);
    expect(roll.elapsedMs()).toBe(3_000);
    // Resuming what isn't paused does nothing.
    await roll.resume(stream, "front");
    expect(api.resume).toHaveBeenCalledTimes(1);
  });

  it("answers a mark the API refused as not recorded", async () => {
    const { roll } = setup({ mark: () => Promise.reject(new Error("RECORDING_ATTEMPT_NOT_OPEN")) });
    await roll.start("abcdefghijk", stream, "front");
    expect(await roll.mark("end", 0, {})).toBe("not_recording");
  });

  it("starts a new part on a flip, and on resuming after the browser stopped the recorder", async () => {
    const { roll, api, queued, recorders, tick } = setup();
    await roll.start("abcdefghijk", stream, "front");
    tick(3_000);
    await roll.flip(stream, "back");
    expect(api.addPart).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, camera: "back" }),
    );
    tick(2_000);
    roll.pause();
    // The phone locked: the browser stopped the recorder while it was paused.
    recorders[1]?.kill();
    await vi.waitFor(() => expect(slices(queued).at(-1)).toEqual(["end", 1, 1]));
    await roll.flip(stream, "front");
    await roll.resume(stream, "front");
    expect(api.addPart).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 2, camera: "front" }),
    );
    expect(api.resume).toHaveBeenCalledWith({ sessionId: SESSION, partIndex: 2, atMs: 0 });
    expect(roll.elapsedMs()).toBe(5_000);
    expect(slices(queued)).toEqual([
      [0, 0, 0, 3_000],
      ["end", 0, 1],
      [1, 0, 0, 2_000],
      ["end", 1, 1],
    ]);
    roll.leave();
    await vi.waitFor(() => expect(slices(queued).at(-1)).toEqual(["end", 2, 1]));
    // Gone already: leaving again, flipping or pausing does nothing.
    roll.leave();
    await roll.flip(stream, "back");
    expect(api.addPart).toHaveBeenCalledTimes(3);
  });

  it("falls back when recording can't start, and finishes even when the API doesn't answer", async () => {
    const refused = setup({ start: () => Promise.reject(new Error("UPSTREAM_UNAVAILABLE")) });
    expect(await refused.roll.start("abcdefghijk", stream, "front")).toBe(false);
    expect(refused.roll.phase).toBe("failed");
    const unsupported = setup({}, false);
    expect(await unsupported.roll.start("abcdefghijk", stream, "front")).toBe(false);
    expect(unsupported.roll.phase).toBe("failed");
    expect(() => unsupported.roll.leave()).not.toThrow();
    const quiet = setup({ finish: () => Promise.reject(new Error("offline")) });
    await quiet.roll.start("abcdefghijk", stream, "front");
    quiet.roll.pause();
    await quiet.roll.done();
    expect(quiet.roll.phase).toBe("done");
    expect(slices(quiet.queued)).toEqual([
      [0, 0, 0, 1],
      ["end", 0, 1],
    ]);
  });
});
