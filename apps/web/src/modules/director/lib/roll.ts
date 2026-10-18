/**
 * The roll: one continuous recording from "Start shooting" to Done, chat included, in
 * ten-second slices handed to the uploader as they're made (packages/client's
 * `useSliceUploader`, which keeps them in IndexedDB until they're stored). Director marks
 * each attempt in it (`mark`), stamped with the recording's own clock, and every marked
 * attempt is cut into a take on the server.
 *
 * A part is one run of the recorder. A camera flip starts a new one (a recorder can't
 * switch tracks), and so does resuming after the browser stopped the recorder (the tab
 * hidden, the phone locked). A part's clock is the media it recorded: pauses don't count.
 * Pausing stops the recording; only the member's touch resumes it.
 */
import type { QueuedItem } from "@repo/client/api/recording/slice-store";
import type { RecordingAttempt } from "@repo/contracts/api";
import type { RecordingSessionId } from "@repo/contracts/ids";
import type { Facing, LiveToolResult } from "@repo/contracts/live";
import { RECORDING_SLICE_MAX_MS, type RecordingType } from "@repo/contracts/recording";
import { SECOND_MS } from "@repo/contracts/time";

/** A shot's place in the roll: a take cut from it, tried, or still to do. */
export type ShotState = "take" | "tried" | "todo";

/** Each shot's place in the roll, from the session's attempts so far. */
export function shotStates(
  count: number,
  attempts: readonly Pick<RecordingAttempt, "shotIndex" | "status">[],
): ShotState[] {
  return Array.from({ length: count }, (_, shot) => {
    const tries = attempts.filter((attempt) => attempt.shotIndex === shot);
    if (tries.some((attempt) => attempt.status === "clipped")) {
      return "take";
    }
    return tries.length > 0 ? "tried" : "todo";
  });
}

/** How often the recorder hands over a slice. */
export const SLICE_MS = 10 * SECOND_MS;

export type RollPhase =
  | "off"
  | "starting"
  | "recording"
  | "paused"
  | "finishing"
  | "done"
  | "failed";

interface Where {
  sessionId: RecordingSessionId;
  partIndex: number;
  atMs: number;
}

/** The API calls the roll makes (the client's recording mutations). */
export interface RollApi {
  start(input: { videoId: string }): Promise<{ id: RecordingSessionId }>;
  addPart(input: {
    sessionId: RecordingSessionId;
    index: number;
    camera: Facing;
    contentType: RecordingType;
  }): Promise<unknown>;
  pause(input: Where): Promise<unknown>;
  resume(input: Where): Promise<unknown>;
  mark(
    input: Where & {
      event: "start" | "end";
      attempt: number;
      shotIndex: number;
      line?: string;
      note?: string;
    },
  ): Promise<unknown>;
  finish(input: { sessionId: RecordingSessionId }): Promise<unknown>;
}

/** One run of a recorder: MediaRecorder in the browser, a stand-in in tests. */
export interface PartRecorder {
  state(): "inactive" | "recording" | "paused";
  start(timesliceMs: number): void;
  /** Hands over what it has recorded since the last slice, now. */
  requestData(): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface RollOptions {
  api: RollApi;
  /**
   * Keeps a slice or a part's end for upload; resolves once it's kept, not sent. The
   * screen pauses when the queue is full (the uploader says so).
   */
  enqueue: (item: QueuedItem) => Promise<unknown>;
  /** A recorder for `stream`, or null when this browser can't record it. */
  record: (
    stream: MediaStream,
    events: { onData: (bytes: Blob) => void; onStop: () => void },
  ) => PartRecorder | null;
  contentType: RecordingType;
  now: () => number;
  onChange: () => void;
}

class Part {
  slices = 0;
  /** Where the next slice starts, in the part's clock. */
  edgeMs = 0;
  /** Media recorded before the current run of it, and when that run began. */
  activeMs = 0;
  since: number | null = null;
  recorder: PartRecorder | null = null;
  ended: Promise<void> = Promise.resolve();

  constructor(
    readonly index: number,
    private readonly now: () => number,
  ) {}

  clock() {
    return this.activeMs + (this.since === null ? 0 : this.now() - this.since);
  }

  /** The clock stops: a pause, or the part's end. */
  freeze() {
    this.activeMs = this.clock();
    this.since = null;
  }
}

export class Roll {
  phase: RollPhase = "off";
  private sessionId: RecordingSessionId | null = null;
  private part: Part | null = null;
  private parts = 0;
  /** Media recorded by the parts that have ended. */
  private endedMs = 0;
  /** The attempts started so far: each start mark numbers the next, its end the same. */
  private attempts = 0;
  /** A camera flipped while the roll was starting: it records once the roll has begun. */
  private flipped: { stream: MediaStream; camera: Facing } | null = null;

  constructor(private readonly options: RollOptions) {}

  /** The recording session, once it's open. */
  currentSession() {
    return this.sessionId;
  }

  /** What the session has recorded so far: the indicator's time. */
  elapsedMs() {
    return this.endedMs + (this.part ? this.part.clock() : 0);
  }

  /** Opens the session and starts recording; false when it couldn't (the shutter's then). */
  async start(videoId: string, stream: MediaStream, camera: Facing) {
    if (this.phase !== "off") {
      return false;
    }
    this.set("starting");
    try {
      this.sessionId = (await this.options.api.start({ videoId })).id;
      await this.openPart(stream, camera);
    } catch {
      // Recording couldn't start here (no recorder, or the API refused): the shoot goes
      // on the old way, one take at a time.
      this.set("failed");
      return false;
    }
    this.set("recording");
    const flipped = this.flipped;
    if (flipped) {
      this.flipped = null;
      await this.flip(flipped.stream, flipped.camera);
    }
    return true;
  }

  /**
   * Hands over what the recorder holds, now rather than at the next ten seconds: on a
   * pause, and when the page goes. A phone that then kills the backgrounded tab loses
   * nothing already recorded.
   */
  flush() {
    if (this.part?.recorder?.state() === "recording") {
      this.part.recorder.requestData();
    }
  }

  /** Stops the recording and what Director sees and hears; only a touch resumes it. */
  pause() {
    const part = this.part;
    if (this.phase !== "recording" || !part) {
      return;
    }
    if (part.recorder?.state() === "recording") {
      this.flush();
      part.recorder.pause();
    }
    part.freeze();
    this.set("paused");
    void this.tell(() => this.options.api.pause(this.where(part)));
  }

  /** The member's touch: recording again, in a new part when the browser stopped the last. */
  async resume(stream: MediaStream, camera: Facing) {
    if (this.phase !== "paused") {
      return;
    }
    let part = this.part;
    if (part?.recorder?.state() === "paused") {
      part.recorder.resume();
      part.since = this.options.now();
    } else {
      part = await this.openPart(stream, camera);
    }
    this.set("recording");
    void this.tell(() => this.options.api.resume(this.where(part)));
  }

  /** The camera flipped: this part ends, and the new camera records in the next one. */
  async flip(stream: MediaStream, camera: Facing) {
    if (this.phase === "starting") {
      // The first part may be opening on the camera that just closed.
      this.flipped = { stream, camera };
      return;
    }
    if (this.phase !== "recording" && this.phase !== "paused") {
      return;
    }
    await this.endPart();
    if (this.phase === "recording") {
      await this.openPart(stream, camera);
    }
  }

  /** Director's mark, stamped with the recording's clock; what came of it for Director. */
  async mark(
    event: "start" | "end",
    shotIndex: number,
    words: { line?: string; note?: string },
  ): Promise<LiveToolResult> {
    if (this.phase === "paused") {
      return "paused";
    }
    const part = this.part;
    if (this.phase !== "recording" || !part || (event === "end" && this.attempts === 0)) {
      return "not_recording";
    }
    if (event === "start") {
      this.attempts += 1;
    }
    const attempt = this.attempts;
    try {
      await this.options.api.mark({ ...this.where(part), event, attempt, shotIndex, ...words });
      return "done";
    } catch {
      // The API refused it (an end with no attempt open, most likely): nothing recorded.
      return "not_recording";
    }
  }

  /** Done: the last part ends, and the session is finished. */
  async done() {
    if (this.phase !== "recording" && this.phase !== "paused") {
      return;
    }
    this.set("finishing");
    await this.endPart();
    await this.tell(() => this.options.api.finish({ sessionId: this.session() }));
    this.set("done");
  }

  /**
   * The screen went: the session ends there, and its footage still uploads (now, or on
   * the next visit to the shoot screen).
   */
  leave() {
    if (this.phase === "recording" || this.phase === "paused") {
      this.phase = "done";
      void this.endPart().then(() =>
        this.tell(() => this.options.api.finish({ sessionId: this.session() })),
      );
    }
  }

  private session() {
    if (!this.sessionId) {
      throw new Error("the roll has no session yet");
    }
    return this.sessionId;
  }

  private where(part: Part): Where {
    return { sessionId: this.session(), partIndex: part.index, atMs: Math.round(part.clock()) };
  }

  private async openPart(stream: MediaStream, camera: Facing) {
    const sessionId = this.session();
    const part = new Part(this.parts, this.options.now);
    this.parts += 1;
    await this.options.api.addPart({
      sessionId,
      index: part.index,
      camera,
      contentType: this.options.contentType,
    });
    let stopped = (): void => undefined;
    part.ended = new Promise((resolve) => {
      stopped = resolve;
    });
    const recorder = this.options.record(stream, {
      onData: (bytes) => this.slice(part, bytes),
      // The part ends whatever became of its end (kept or not): a flip or Done waits on it.
      onStop: () => void this.closed(part).finally(stopped),
    });
    if (!recorder) {
      throw new Error("this browser can't record the camera");
    }
    part.recorder = recorder;
    recorder.start(SLICE_MS);
    part.since = this.options.now();
    this.part = part;
    return part;
  }

  private slice(part: Part, bytes: Blob) {
    if (bytes.size === 0) {
      return;
    }
    const startMs = part.edgeMs;
    const durationMs = Math.min(
      RECORDING_SLICE_MAX_MS,
      Math.max(1, Math.round(part.clock()) - startMs),
    );
    part.edgeMs = startMs + durationMs;
    const index = part.slices;
    part.slices += 1;
    void this.options.enqueue({
      kind: "slice",
      sessionId: this.session(),
      partIndex: part.index,
      index,
      startMs,
      durationMs,
      bytes,
    });
  }

  /** The recorder stopped (asked to, or by the browser): the part's end is queued. */
  private async closed(part: Part) {
    part.freeze();
    if (this.part === part) {
      this.part = null;
      this.endedMs += part.activeMs;
    }
    await this.options.enqueue({
      kind: "part-end",
      sessionId: this.session(),
      partIndex: part.index,
      sliceCount: part.slices,
    });
  }

  private async endPart() {
    const part = this.part;
    if (!part) {
      return;
    }
    part.freeze();
    // A part in hand is still recording (or paused): one the browser stopped has gone.
    part.recorder?.stop();
    await part.ended;
  }

  /**
   * Tells the API (a pause, a resume, Done). The recording already did it here; a refusal
   * changes nothing on screen, and the session's footage and marks stay as they are.
   */
  private async tell(call: () => Promise<unknown>) {
    try {
      await call();
    } catch {
      return;
    }
  }

  private set(phase: RollPhase) {
    this.phase = phase;
    this.options.onChange();
  }
}
