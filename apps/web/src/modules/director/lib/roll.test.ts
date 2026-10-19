import type { QueuedItem } from "@repo/client/api/recording/slice-store";
import { recordingSessionIdSchema } from "@repo/contracts/ids";
import { describe, expect, it, vi } from "vitest";
import { MIN_PART_MS, type PartRecorder, Roll, type RollApi, SLICE_MS } from "./roll";

const SESSION = recordingSessionIdSchema.parse("6b1d3a52-8d1e-4c3b-9a55-2f1e7c9d0a11");
const stream = {} as MediaStream;

/** A recorder that hands over what the test says, when it says. */
class FakeRecorder implements PartRecorder {
  current: "inactive" | "recording" | "paused" = "inactive";
  timeslice = 0;
  constructor(
    readonly events: { onData: (bytes: Blob) => void; onStop: () => void },
    readonly stream: MediaStream,
  ) {}
  /** Hands over what it has so far, as MediaRecorder's requestData does. */
  requestData() {
    this.events.onData(new Blob(["so far"]));
  }
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

const FRESH = { id: SESSION, recordedMs: 0, parts: [], attempts: [] };

function setup(
  overrides: Partial<RollApi> = {},
  canRecord = true,
  leftQueued: QueuedItem[] | Error = [],
) {
  let clock = 0;
  const queued: QueuedItem[] = [];
  const recorders: FakeRecorder[] = [];
  const api = {
    start: vi.fn<RollApi["start"]>(() => Promise.resolve(FRESH)),
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
    queued: () =>
      leftQueued instanceof Error ? Promise.reject(leftQueued) : Promise.resolve(leftQueued),
    record: (recorded, events) => {
      if (!canRecord) {
        return null;
      }
      const recorder = new FakeRecorder(events, recorded);
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
    const mark = vi.fn<RollApi["mark"]>(() => Promise.resolve({}));
    const { roll, api, recorders, tick } = setup({ mark });
    expect(await roll.mark("start", 0, {})).toBe("not_recording");
    await roll.start("abcdefghijk", stream, "front");
    // No attempt has started: there's nothing to end.
    expect(await roll.mark("end", 0, {})).toBe("not_recording");
    tick(2_000);
    expect(await roll.mark("start", 1, { line: "Hi!" })).toBe("done");
    expect(mark).toHaveBeenCalledWith({
      sessionId: SESSION,
      partIndex: 0,
      atMs: 2_000,
      event: "start",
      attempt: 1,
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
    // The attempt that started ends with the same number; the next is the second.
    expect(await roll.mark("end", 1, { note: "Good" })).toBe("done");
    expect(await roll.mark("start", 2, {})).toBe("done");
    expect(mark.mock.calls.map(([input]) => [input.event, input.attempt])).toEqual([
      ["start", 1],
      ["end", 1],
      ["start", 2],
    ]);
  });

  it("answers a mark the API refused as not recorded", async () => {
    const { roll } = setup({ mark: () => Promise.reject(new Error("RECORDING_PAUSED")) });
    await roll.start("abcdefghijk", stream, "front");
    expect(await roll.mark("start", 0, {})).toBe("not_recording");
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
    await vi.waitFor(() => expect(slices(queued).at(-1)).toEqual(["end", 1, 2]));
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
      // Handed over on the pause: what a phone that kills the tab next would lose.
      [1, 0, 0, 2_000],
      [1, 1, 2_000, 1],
      ["end", 1, 2],
    ]);
    roll.leave();
    // Left the moment it opened: part 2 recorded nothing, so none of it is sent.
    await vi.waitFor(() => expect(slices(queued).at(-1)).toEqual(["end", 2, 0]));
    expect(slices(queued).filter(([part]) => part === 2)).toEqual([]);
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
    // Paused and done before a moment was recorded: the part's slices hold no frames.
    expect(slices(quiet.queued)).toEqual([["end", 0, 0]]);
  });

  it("hands over what it has recorded on a pause, and when the page goes", async () => {
    const { roll, queued, tick } = setup();
    // Nothing to hand over before it records.
    roll.flush();
    await roll.start("abcdefghijk", stream, "front");
    tick(4_000);
    roll.pause();
    expect(slices(queued)).toEqual([[0, 0, 0, 4_000]]);
    // Paused, it has nothing new.
    roll.flush();
    expect(queued).toHaveLength(1);
    await roll.resume(stream, "front");
    tick(1_000);
    roll.flush();
    expect(slices(queued)).toEqual([
      [0, 0, 0, 4_000],
      [0, 1, 4_000, 1_000],
    ]);
  });

  it("records the new camera when it flips while the roll is still starting", async () => {
    let opened = (): void => undefined;
    const { roll, api, recorders } = setup({
      start: () =>
        new Promise((resolve) => {
          opened = () => resolve(FRESH);
        }),
    });
    const front = new EventTarget() as MediaStream;
    const back = new EventTarget() as MediaStream;
    const starting = roll.start("abcdefghijk", front, "front");
    expect(roll.phase).toBe("starting");
    // The front camera has already closed by now: recording it would record nothing.
    const flipped = roll.flip(back, "back");
    opened();
    expect(await starting).toBe(true);
    await flipped;
    await vi.waitFor(() => expect(recorders.at(-1)?.stream).toBe(back));
    expect(roll.phase).toBe("recording");
    expect(api.addPart).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, camera: "back" }),
    );
    expect(recorders.at(-1)?.current).toBe("recording");
  });

  it("carries on a session a closed tab left open, closing the parts it never ended", async () => {
    const left = {
      id: SESSION,
      recordedMs: 42_000,
      parts: [
        { index: 0, sliceCount: 3, uploaded: [0, 1, 2] },
        // The tab died recording part 1: two slices stored, a third still on this device.
        { index: 1, sliceCount: null, uploaded: [0, 1] },
        // Part 2's end is already waiting on this device.
        { index: 2, sliceCount: null, uploaded: [] },
      ],
      attempts: [{ number: 1 }, { number: 2 }],
    };
    const leftQueued: QueuedItem[] = [
      {
        kind: "slice",
        sessionId: SESSION,
        partIndex: 1,
        index: 2,
        startMs: 20_000,
        durationMs: 4_000,
        bytes: new Blob(["x"]),
      },
      { kind: "part-end", sessionId: SESSION, partIndex: 2, sliceCount: 0 },
    ];
    const { roll, api, queued } = setup({ start: () => Promise.resolve(left) }, true, leftQueued);
    expect(await roll.start("abcdefghijk", stream, "front")).toBe(true);
    expect(slices(queued)).toEqual([["end", 1, 3]]);
    // The next part and attempt follow the ones before; the indicator counts them.
    expect(api.addPart).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
    expect(roll.elapsedMs()).toBe(42_000);
    await roll.mark("start", 0, {});
    expect(api.mark).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3, partIndex: 3 }));
  });

  it("closes the parts a tab left open even when this device's queue can't be read", async () => {
    const left = { ...FRESH, parts: [{ index: 0, sliceCount: null, uploaded: [0] }] };
    const { roll, queued } = setup(
      { start: () => Promise.resolve(left) },
      true,
      new Error("IndexedDB gone"),
    );
    await roll.start("abcdefghijk", stream, "front");
    expect(slices(queued)).toEqual([["end", 0, 1]]);
  });

  it("starts a new part when the camera's picture changes size", async () => {
    const { roll, api, queued, recorders, tick } = setup();
    const front = new EventTarget() as MediaStream;
    const back = new EventTarget() as MediaStream;
    // The viewfinder showed the camera before the roll began: the first part records at it.
    await roll.reframe(front, { width: 720, height: 1280 });
    await roll.start("abcdefghijk", front, "front");
    tick(3_000);
    await roll.reframe(front, { width: 720, height: 1280 });
    // Another camera's picture isn't this part's.
    await roll.reframe(back, { width: 1080, height: 1920 });
    expect(api.addPart).toHaveBeenCalledTimes(1);
    await roll.reframe(front, { width: 1080, height: 1920 });
    expect(api.addPart).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, camera: "front" }),
    );
    expect(recorders.map((recorder) => recorder.stream)).toEqual([front, front]);
    expect(slices(queued)).toEqual([
      [0, 0, 0, 3_000],
      ["end", 0, 1],
    ]);

    // A flipped camera's part takes the first size it's shown at, then changes like any.
    tick(2_000);
    await roll.flip(back, "back");
    await roll.reframe(back, { width: 1080, height: 1920 });
    expect(api.addPart).toHaveBeenCalledTimes(3);
    tick(1_000);
    await roll.reframe(back, { width: 1920, height: 1080 });
    expect(api.addPart).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 3, camera: "back" }),
    );

    // Paused, the part ends on a new size, and the next opens on the touch that resumes.
    tick(1_000);
    roll.pause();
    await roll.reframe(back, { width: 1080, height: 1920 });
    expect(recorders.at(-1)?.current).toBe("inactive");
    expect(api.addPart).toHaveBeenCalledTimes(4);
    await roll.resume(back, "back");
    expect(api.addPart).toHaveBeenCalledTimes(5);
    // The part that opened knows the size already: the same size again changes nothing.
    await roll.reframe(back, { width: 1080, height: 1920 });
    expect(api.addPart).toHaveBeenCalledTimes(5);
  });

  it("sends nothing of a part that ends before it records half a second", async () => {
    const { roll, queued, tick } = setup();
    const camera = new EventTarget() as MediaStream;
    await roll.reframe(camera, { width: 640, height: 480 });
    await roll.start("abcdefghijk", camera, "front");
    tick(MIN_PART_MS - 200);
    // Paused at once: what it hands over waits until the part has recorded enough.
    roll.pause();
    expect(queued).toEqual([]);
    await roll.resume(camera, "front");
    tick(100);
    // The camera settled on its own size: the first part never reached half a second.
    await roll.reframe(camera, { width: 720, height: 1280 });
    expect(slices(queued)).toEqual([["end", 0, 0]]);

    // The next part held its first slice too, and sends it once it has recorded enough.
    tick(MIN_PART_MS - 100);
    roll.pause();
    expect(slices(queued)).toEqual([["end", 0, 0]]);
    await roll.resume(camera, "front");
    tick(200);
    roll.flush();
    expect(slices(queued)).toEqual([
      ["end", 0, 0],
      [1, 0, 0, MIN_PART_MS - 100],
      [1, 1, MIN_PART_MS - 100, 200],
    ]);
    await roll.done();
    expect(slices(queued).at(-1)).toEqual(["end", 1, 3]);
  });
});
