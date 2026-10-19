/**
 * The roll: one continuous recording from "Start shooting" to Done, chat included, in
 * ten-second slices handed to the uploader as they're made (packages/client's
 * `useSliceUploader`, which keeps them in IndexedDB until they're stored). Director marks
 * each attempt in it (`mark`), stamped with the recording's own clock, and every marked
 * attempt is cut into a take on the server.
 *
 * A part is one run of the recorder. A camera flip starts a new one (a recorder can't
 * switch tracks), and so does resuming after the browser stopped the recorder (the tab
 * hidden, the phone locked), and so does the camera's picture changing size: an MP4
 * recorder keeps the first size's codec description for the whole file, and the frames
 * after the change come out unreadable. A part's clock is the media it recorded: pauses
 * don't count. Pausing stops the recording; only the member's touch resumes it.
 *
 * A part that ends before it has recorded half a second (a picture that changed size as
 * the camera settled, a flip straight after another) is dropped whole: the clipper cuts
 * nothing that short, and its slices would be a file with no frames in it.
 */
import type { QueuedItem, QueuedSlice } from "@repo/client/api/recording/slice-store";
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

/**
 * The least a part records for its slices to be uploaded: the clipper's shortest cut
 * (MIN_CLIP_MS in apps/ai/app/clipping.py), so a part shorter than this holds no take.
 */
export const MIN_PART_MS = SECOND_MS / 2;

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

/**
 * The session the API answers a start with: a new one, or the member's session of the
 * short still recording (a tab closed before Done), with what it recorded so far.
 */
interface StartedSession {
  id: RecordingSessionId;
  recordedMs: number;
  parts: readonly { index: number; sliceCount: number | null; uploaded: readonly number[] }[];
  attempts: readonly { number: number }[];
}

/** The API calls the roll makes (the client's recording mutations). */
export interface RollApi {
  start(input: { videoId: string }): Promise<StartedSession>;
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
  /** What this device still holds to upload (an earlier visit's leftovers included). */
  queued: () => Promise<readonly QueuedItem[]>;
  /** A recorder for `stream`, or null when this browser can't record it. */
  record: (
    stream: MediaStream,
    events: { onData: (bytes: Blob) => void; onStop: () => void },
  ) => PartRecorder | null;
  contentType: RecordingType;
  now: () => number;
  onChange: () => void;
}

/** The size of the picture a camera shows, as the viewfinder reports it. */
export interface PictureSize {
  width: number;
  height: number;
}

class Part {
  slices = 0;
  /** Slices made before the part had recorded MIN_PART_MS, not queued until it has. */
  held: QueuedSlice[] = [];
  /** The picture's size it records at ("1080x1920"), once the viewfinder has said. */
  picture: string | null = null;
  /** Where the next slice starts, in the part's clock. */
  edgeMs = 0;
  /** Media recorded before the current run of it, and when that run began. */
  activeMs = 0;
  since: number | null = null;
  recorder: PartRecorder | null = null;
  ended: Promise<void> = Promise.resolve();

  constructor(
    readonly index: number,
    readonly stream: MediaStream,
    readonly camera: Facing,
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
  /** The latest picture size the viewfinder reported, and for which stream. */
  private picture: { stream: MediaStream; size: string } | null = null;

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
      const session = await this.options.api.start({ videoId });
      this.sessionId = session.id;
      await this.carryOn(session);
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
   * A session a closed tab left recording goes on from where it was: its parts and
   * attempts are numbered after the ones it has, the indicator counts what it recorded,
   * and each part the tab never ended is ended now (its slices are the ones stored and
   * the ones still on this device), so its attempts can become takes.
   */
  private async carryOn(session: StartedSession) {
    this.parts = Math.max(0, ...session.parts.map((part) => part.index + 1));
    this.attempts = Math.max(0, ...session.attempts.map((attempt) => attempt.number));
    this.endedMs = session.recordedMs;
    const open = session.parts.filter((part) => part.sliceCount === null);
    if (open.length === 0) {
      return;
    }
    const left = await this.options.queued().catch(() => []);
    const mine = left.filter((item) => item.sessionId === session.id);
    for (const part of open) {
      const queued = mine.filter((item) => item.partIndex === part.index);
      const queuedSlices = queued.filter((item) => item.kind === "slice");
      // Anything else queued is its end, already on its way.
      if (queuedSlices.length < queued.length) {
        continue;
      }
      const slices = [...part.uploaded, ...queuedSlices.map((item) => item.index)];
      await this.options.enqueue({
        kind: "part-end",
        sessionId: session.id,
        partIndex: part.index,
        sliceCount: Math.max(0, ...slices.map((index) => index + 1)),
      });
    }
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
    await this.nextPart(stream, camera);
  }

  /**
   * The viewfinder's picture of `stream` is now `size`. The first size a part sees is the
   * one it records at; another (the camera settling on its resolution, a phone turned)
   * ends the part, and the same camera goes on in the next one.
   */
  async reframe(stream: MediaStream, size: PictureSize) {
    const picture = `${size.width}x${size.height}`;
    this.picture = { stream, size: picture };
    const part = this.part;
    if (!part || part.stream !== stream || part.picture === picture) {
      return;
    }
    const known = part.picture !== null;
    // Set now, so the same size reported again while the next part opens changes nothing.
    part.picture = picture;
    if (known) {
      await this.nextPart(stream, part.camera);
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

  /** This part ends, and `stream` records in the next one (once the roll isn't paused). */
  private async nextPart(stream: MediaStream, camera: Facing) {
    if (this.phase !== "recording" && this.phase !== "paused") {
      return;
    }
    await this.endPart();
    if (this.phase === "recording") {
      await this.openPart(stream, camera);
    }
  }

  private async openPart(stream: MediaStream, camera: Facing) {
    const sessionId = this.session();
    const part = new Part(this.parts, stream, camera, this.options.now);
    part.picture = this.picture?.stream === stream ? this.picture.size : null;
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
    part.held.push({
      kind: "slice",
      sessionId: this.session(),
      partIndex: part.index,
      index,
      startMs,
      durationMs,
      bytes,
    });
    if (part.clock() >= MIN_PART_MS) {
      this.release(part);
    }
  }

  /** Queues the slices a part held back, in order, now it has recorded enough to keep. */
  private release(part: Part) {
    for (const slice of part.held.splice(0)) {
      void this.options.enqueue(slice);
    }
  }

  /**
   * The recorder stopped (asked to, or by the browser): the part's end is queued, with
   * no slices at all when it ended too short to keep.
   */
  private async closed(part: Part) {
    part.freeze();
    // Counted however late its stop comes: a part the browser stopped while paused can
    // end after the touch that resumed opened the next one.
    this.endedMs += part.activeMs;
    if (this.part === part) {
      this.part = null;
    }
    const kept = part.activeMs >= MIN_PART_MS;
    if (kept) {
      this.release(part);
    }
    await this.options.enqueue({
      kind: "part-end",
      sessionId: this.session(),
      partIndex: part.index,
      sliceCount: kept ? part.slices : 0,
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
