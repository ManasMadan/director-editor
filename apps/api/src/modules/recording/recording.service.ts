/**
 * Director's continuous recording (packages/contracts api/recording.ts has the flow). The
 * browser uploads ten-second slices straight to storage through URLs signed here, for
 * exactly the slice it described; Director's marks say where each attempt at a shot
 * starts and ends. Once an ended attempt's footage is all stored, it goes on the
 * `recording` queue, and apps/worker has the clipper cut it into a take.
 *
 * Each session is its member's own: every call names them, and row-level security holds
 * it to their workspace. Slices skip the uploads' virus scan and type check (a scan
 * never protected a decoder anyway). What stands between them and ffmpeg instead: a
 * part's first slice must start the way its recorder's type does (checked here), and
 * the clipper decodes only that type, reads only local files, and runs with no secrets
 * and capped resources, on the Cloud Run clipper in production (apps/ai app/clipping.py).
 * The take is the clipper's own re-encode.
 */
import { Inject, Injectable } from "@nestjs/common";
import type {
  RecordingAttempt,
  RecordingPart,
  RecordingSession,
  RecordingSessionDetail,
} from "@repo/contracts/api";
import {
  type DirectorTakeId,
  directorPlanIdSchema,
  type OrgId,
  type RecordingSessionId,
  recordingAttemptIdSchema,
  recordingSessionIdSchema,
  type UserId,
  type VideoId,
} from "@repo/contracts/ids";
import {
  countedMs,
  looksLikeRecording,
  RECORDING_FOOTAGE_MAX_BYTES,
  RECORDING_KEEP_DAYS,
  RECORDING_KEEP_MAX_DAYS,
  RECORDING_MAX_MS,
  RECORDING_SLICE_MAX_BYTES,
  RECORDING_SLICE_MAX_MS,
  RECORDING_TYPES,
  type RecordingType,
  recordingSliceKey,
  SESSION_PASS_DELAY_MS,
} from "@repo/contracts/recording";
import { MINUTE_MS, MINUTE_S } from "@repo/contracts/time";
import { type Tx, tenantTx } from "@repo/db";
import type { Producer } from "@repo/jobs";
import { AppError, currentContext, type Database, InjectDatabase } from "@repo/nest-common";
import * as z from "zod";
import { aiCaller, callAi } from "../ai";
import { FilesService } from "../files";
import { RecordingRepository } from "./recording.repository";
import { endOf, expiresAt, readyAttempts, toAttempt, toPart, toSession } from "./rules";

export const RECORDING_QUEUE = Symbol("RECORDING_QUEUE");
export const DIRECTOR_QUEUE = Symbol("DIRECTOR_QUEUE");

// A slow connection on a phone: long enough to send a slice, no longer.
const SLICE_UPLOAD_EXPIRES_S = 10 * MINUTE_S;
// A recorder's file signature is in its first bytes (an MP4's `ftyp` box from the 5th).
const SIGNATURE_BYTES = 12;
const recordingType = z.enum(RECORDING_TYPES);

/** Who's recording: the procedure's caller. */
export interface Recorder {
  orgId: OrgId;
  userId: UserId;
  /** The demo (the shared account, or a private guest): footage kept 24 hours. */
  demo: boolean;
  /** The one demo account everyone signs in to: it may not record at all. */
  sharedDemo: boolean;
}

type Caller = Pick<Recorder, "orgId" | "userId">;

// What a session needs of its plan, from the AI service that owns plans.
const planOf = z.object({
  id: directorPlanIdSchema,
  status: z.string(),
  plan: z.object({ shots: z.array(z.unknown()) }).nullable(),
});

type Mark = {
  sessionId: RecordingSessionId;
  event: "start" | "end";
  attempt: number;
  shotIndex: number;
  partIndex: number;
  atMs: number;
  line?: string | undefined;
  note?: string | undefined;
};

type SliceInput = {
  sessionId: RecordingSessionId;
  partIndex: number;
  index: number;
  startMs: number;
  durationMs: number;
  size: number;
};

@Injectable()
export class RecordingService {
  constructor(
    private readonly recordings: RecordingRepository,
    private readonly files: FilesService,
    @InjectDatabase() private readonly database: Database,
    @Inject(RECORDING_QUEUE) private readonly queue: Producer<"recording">,
    @Inject(DIRECTOR_QUEUE) private readonly director: Producer<"ai-director">,
  ) {}

  /**
   * Opens a session on a ready plan, unless the member's footage is at its allowance. A
   * session of theirs still recording for the same short (the tab closed or crashed
   * before Done) is carried on instead: a second one would leave the first open forever,
   * its takes never reaching the editor as a finished shoot.
   */
  async start(
    { orgId, userId, demo, sharedDemo }: Recorder,
    videoId: VideoId,
  ): Promise<RecordingSessionDetail> {
    if (sharedDemo) {
      // Everyone on the shared account is the same member: they'd see each other's
      // sessions, chatter included. A demo guest records like anyone, for a day.
      throw new AppError("DEMO_ACCOUNT_LOCKED");
    }
    this.files.requireStorage();
    const plan = await this.readyPlan({ orgId, userId }, videoId);
    const bytes = await tenantTx(this.database.write, orgId, (tx) =>
      this.recordings.footageBytes(tx, userId),
    );
    if (bytes >= RECORDING_FOOTAGE_MAX_BYTES) {
      throw new AppError("RECORDING_STORAGE_FULL");
    }
    const open = await this.recordings.openSession(orgId, userId, videoId);
    if (open) {
      return this.session({ orgId, userId }, recordingSessionIdSchema.parse(open.id));
    }
    const row = await this.recordings.createSession(orgId, {
      userId,
      planId: plan.id,
      videoId,
      shotCount: plan.shots,
      demo,
      expiresAt: expiresAt(new Date(), demo),
    });
    return { ...toSession(row), parts: [], attempts: [] };
  }

  async sessions({ orgId, userId }: Caller): Promise<RecordingSession[]> {
    return (await this.recordings.sessions(orgId, userId)).map(toSession);
  }

  async session(caller: Caller, sessionId: RecordingSessionId): Promise<RecordingSessionDetail> {
    const session = await this.find(caller, sessionId);
    const { parts, attempts } = await this.recordings.footage(caller.orgId, sessionId);
    return { ...toSession(session), parts: parts.map(toPart), attempts: attempts.map(toAttempt) };
  }

  async addPart(
    caller: Caller,
    input: {
      sessionId: RecordingSessionId;
      index: number;
      camera: "front" | "back";
      contentType: RecordingType;
    },
  ): Promise<RecordingPart> {
    await this.recording(caller, input.sessionId);
    const part = await this.recordings.addPart(caller.orgId, input);
    if (!part || part.camera !== input.camera || part.contentType !== input.contentType) {
      throw new AppError("RECORDING_PART_CLOSED");
    }
    return toPart(part);
  }

  /**
   * The recorder stopped: the part has `sliceCount` slices. Allowed after Done, for a shoot
   * screen reopened after the tab died.
   */
  async closePart(
    caller: Caller,
    input: { sessionId: RecordingSessionId; index: number; sliceCount: number },
  ): Promise<RecordingPart> {
    await this.find(caller, input.sessionId);
    const part = await this.part(caller.orgId, input.sessionId, input.index);
    const beyond = part.slices.some((slice) => slice.index >= input.sliceCount);
    if (beyond || (part.sliceCount !== null && part.sliceCount !== input.sliceCount)) {
      throw new AppError("RECORDING_PART_CLOSED");
    }
    await this.recordings.closePart(caller.orgId, input.sessionId, input.index, input.sliceCount);
    await this.clipReady(caller, input.sessionId);
    return toPart({ ...part, sliceCount: input.sliceCount });
  }

  /**
   * Signs one slice's upload (null when it's stored already). The limits are checked and
   * the slice signed in one transaction, holding the member's footage, so uploads racing
   * each other can't all fit the same last space.
   */
  async uploadSlice(caller: Caller, input: SliceInput) {
    const { orgId } = caller;
    await this.find(caller, input.sessionId);
    const part = await this.part(orgId, input.sessionId, input.partIndex);
    if (part.sliceCount !== null && input.index >= part.sliceCount) {
      throw new AppError("RECORDING_PART_CLOSED");
    }
    const signed = part.slices.find((slice) => slice.index === input.index);
    if (signed?.status === "uploaded") {
      return { upload: null };
    }
    this.files.requireStorage();
    await tenantTx(this.database.write, orgId, async (tx) => {
      await this.recordings.lockFootage(tx, caller.userId);
      await this.withinLimits(tx, caller, input, signed);
      await this.recordings.signSlice(tx, { ...input, orgId });
    });
    const key = recordingSliceKey(input.sessionId, input.partIndex, input.index);
    const upload = await this.files.signObjectUpload(
      key,
      part.contentType,
      input.size,
      SLICE_UPLOAD_EXPIRES_S,
    );
    return { upload };
  }

  /**
   * The slice is stored: counted on the session, and any ended attempt it completes goes
   * to the clipper. Safe to call again (a lost answer, a reopened shoot screen). A part's
   * first slice that doesn't start like its recorder's type is deleted and refused.
   */
  async completeSlice(
    caller: Caller,
    input: { sessionId: RecordingSessionId; partIndex: number; index: number },
  ): Promise<RecordingSession> {
    const { orgId } = caller;
    await this.find(caller, input.sessionId);
    const slice = await this.recordings.slice(orgId, input.sessionId, input.partIndex, input.index);
    if (!slice) {
      throw new AppError("RECORDING_SLICE_NOT_UPLOADED");
    }
    if (slice.status === "pending") {
      const key = recordingSliceKey(input.sessionId, input.partIndex, input.index);
      // The upload was signed for exactly this size: anything else is an upload that
      // didn't finish.
      if ((await this.files.storedSize(key)) !== slice.size) {
        throw new AppError("RECORDING_SLICE_NOT_UPLOADED");
      }
      if (input.index === 0) {
        await this.checkSignature(orgId, input, key);
      }
      await tenantTx(this.database.write, orgId, (tx) => this.recordings.storeSlice(tx, input));
    }
    await this.clipReady(caller, input.sessionId);
    return toSession(await this.find(caller, input.sessionId));
  }

  /** Director's mark: an attempt starts or ends. */
  async mark(caller: Caller, input: Mark): Promise<RecordingAttempt> {
    const { orgId } = caller;
    const session = await this.find(caller, input.sessionId);
    const part = await this.part(orgId, input.sessionId, input.partIndex);
    const attempt = await tenantTx(this.database.write, orgId, async (tx) => {
      const status = await this.recordings.lockSession(tx, input.sessionId);
      const again = await this.recordings.attemptNumbered(tx, input.sessionId, input.attempt);
      if (input.event === "end") {
        return this.endAttempt(tx, input, again);
      }
      if (again) {
        // The same start sent again.
        return again;
      }
      await this.mayStart(tx, status, input, {
        shotCount: session.shotCount,
        partOpen: part.sliceCount === null,
      });
      return this.startAttempt(tx, orgId, input);
    });
    await this.clipReady(caller, input.sessionId);
    return toAttempt(attempt);
  }

  /** Recording paused: an open attempt ends where it did. Pausing twice is fine. */
  async pause(
    caller: Caller,
    input: { sessionId: RecordingSessionId; partIndex: number; atMs: number },
  ): Promise<RecordingSession> {
    const { orgId } = caller;
    await this.find(caller, input.sessionId);
    await this.part(orgId, input.sessionId, input.partIndex);
    await tenantTx(this.database.write, orgId, async (tx) => {
      this.stillRecording(await this.recordings.lockSession(tx, input.sessionId));
      if (await this.recordings.openPause(tx, input.sessionId)) {
        return;
      }
      const open = await this.recordings.openAttempt(tx, input.sessionId);
      if (open) {
        await this.recordings.endAttempt(
          tx,
          recordingAttemptIdSchema.parse(open.id),
          endOf(open, input),
        );
      }
      await this.recordings.pause(tx, {
        orgId,
        sessionId: input.sessionId,
        partIndex: input.partIndex,
        startMs: input.atMs,
      });
    });
    await this.clipReady(caller, input.sessionId);
    return toSession(await this.find(caller, input.sessionId));
  }

  /** Recording resumed, from a touch: the pause ends there (or ran to its part's end). */
  async resume(
    caller: Caller,
    input: { sessionId: RecordingSessionId; partIndex: number; atMs: number },
  ): Promise<RecordingSession> {
    const { orgId } = caller;
    await this.find(caller, input.sessionId);
    await this.part(orgId, input.sessionId, input.partIndex);
    await tenantTx(this.database.write, orgId, async (tx) => {
      this.stillRecording(await this.recordings.lockSession(tx, input.sessionId));
      const pause = await this.recordings.openPause(tx, input.sessionId);
      if (pause) {
        await this.recordings.resume(
          tx,
          { sessionId: input.sessionId, ...pause },
          endOf({ partIndex: pause.partIndex, startMs: pause.startMs }, input),
        );
      }
    });
    return toSession(await this.find(caller, input.sessionId));
  }

  /**
   * Done: an open attempt runs to its part's end, and the session records nothing more.
   * Done twice (or racing itself) finishes it once.
   */
  async finish(caller: Caller, sessionId: RecordingSessionId): Promise<RecordingSession> {
    await this.find(caller, sessionId);
    await tenantTx(this.database.write, caller.orgId, async (tx) => {
      if ((await this.recordings.lockSession(tx, sessionId)) !== "recording") {
        return;
      }
      const open = await this.recordings.openAttempt(tx, sessionId);
      if (open) {
        await this.recordings.endAttempt(tx, recordingAttemptIdSchema.parse(open.id), null);
      }
      const pause = await this.recordings.openPause(tx, sessionId);
      if (pause) {
        await this.recordings.resume(tx, { sessionId, ...pause }, null);
      }
      await this.recordings.finish(tx, sessionId);
    });
    await this.clipReady(caller, sessionId);
    await this.queuePass(caller, sessionId);
    return toSession(await this.find(caller, sessionId));
  }

  /**
   * Queues the post-session pass of a done session whose pass isn't queued yet: after the
   * commit, so a queue that fails leaves it unqueued for the next Done, or for the
   * worker's recording retention, to queue again. The session's id is the job's, so it
   * goes through once.
   */
  private async queuePass(caller: Caller, sessionId: RecordingSessionId) {
    if (!(await this.recordings.passDue(caller.orgId, sessionId))) {
      return;
    }
    const meta = {
      requestId: currentContext()?.requestId,
      userId: caller.userId,
      orgId: caller.orgId,
    };
    await this.director.add(
      "session-pass",
      { sessionId, orgId: caller.orgId },
      { jobId: sessionId, meta, delay: SESSION_PASS_DELAY_MS },
    );
    await this.recordings.passQueued(caller.orgId, sessionId);
  }

  /**
   * Deletes the session now, in one statement: its raw footage, and every take cut from
   * it (the database deletes an attempt's file with it, and the take with the file).
   */
  async remove(caller: Caller, sessionId: RecordingSessionId) {
    await this.find(caller, sessionId);
    await this.recordings.remove(caller.orgId, caller.userId, sessionId);
    return { removed: true as const };
  }

  /**
   * A video saved from takes `takeIds` keeps the footage they were cut from for another
   * RECORDING_KEEP_DAYS, up to RECORDING_KEEP_MAX_DAYS after it was recorded.
   */
  async keepFootageOf({ orgId, userId }: Caller, takeIds: readonly DirectorTakeId[]) {
    await tenantTx(this.database.write, orgId, (tx) =>
      this.recordings.keep(tx, userId, takeIds, RECORDING_KEEP_DAYS, RECORDING_KEEP_MAX_DAYS),
    );
  }

  // -------------------------------------------------------------------------- steps

  private async readyPlan(caller: Caller, videoId: VideoId) {
    const plan = planOf.parse(
      await callAi((ai) => ai.director.getPlan(aiCaller(caller.userId, caller.orgId), videoId)),
    );
    if (plan.status !== "ready" || !plan.plan) {
      throw new AppError("DIRECTOR_PLAN_NOT_READY");
    }
    return { id: plan.id, shots: plan.plan.shots.length };
  }

  private async find(caller: Caller, sessionId: RecordingSessionId) {
    const session = await this.recordings.session(caller.orgId, caller.userId, sessionId);
    if (!session) {
      throw new AppError("RECORDING_NOT_FOUND");
    }
    return session;
  }

  /** The member's session, still recording (RECORDING_FINISHED after Done). */
  private async recording(caller: Caller, sessionId: RecordingSessionId) {
    const session = await this.find(caller, sessionId);
    this.stillRecording(session.status);
    return session;
  }

  private stillRecording(status: string) {
    if (status !== "recording") {
      throw new AppError("RECORDING_FINISHED");
    }
  }

  private async part(orgId: OrgId, sessionId: RecordingSessionId, index: number) {
    const part = await this.recordings.part(orgId, sessionId, index);
    if (!part) {
      throw new AppError("RECORDING_PART_NOT_FOUND");
    }
    return part;
  }

  /**
   * A slice keeps the session inside its 20 minutes, as the server counts them (the last
   * slice may run a little over), and the member inside their footage allowance. A slice
   * signed again counts once. Run under lockFootage.
   */
  private async withinLimits(
    tx: Tx,
    { userId }: Caller,
    input: SliceInput,
    signed: { durationMs: number; size: number } | undefined,
  ) {
    const before = signed ? countedMs(signed) : 0;
    const counted = (await this.recordings.countedMs(tx, input.sessionId)) - before;
    if (counted + countedMs(input) > RECORDING_MAX_MS + RECORDING_SLICE_MAX_MS) {
      throw new AppError("RECORDING_LIMIT_REACHED", {
        params: { maxMinutes: RECORDING_MAX_MS / MINUTE_MS },
      });
    }
    const bytes = (await this.recordings.footageBytes(tx, userId)) - (signed?.size ?? 0);
    if (bytes + input.size > RECORDING_FOOTAGE_MAX_BYTES) {
      throw new AppError("RECORDING_STORAGE_FULL");
    }
  }

  /**
   * A part's first bytes are checked before its footage counts: they must be the
   * recorder's type the part declared, which is the only format the clipper reads it as.
   * One that isn't is deleted from storage and forgotten.
   */
  private async checkSignature(
    orgId: OrgId,
    slice: { sessionId: RecordingSessionId; partIndex: number; index: number },
    key: string,
  ) {
    const part = await this.part(orgId, slice.sessionId, slice.partIndex);
    const head = (await this.files.readObject(key, RECORDING_SLICE_MAX_BYTES)).subarray(
      0,
      SIGNATURE_BYTES,
    );
    if (!looksLikeRecording(head, recordingType.parse(part.contentType))) {
      await this.recordings.dropSlice(orgId, slice);
      await this.files.deleteObject(key);
      throw new AppError("RECORDING_SLICE_INVALID");
    }
  }

  /** Whether a new attempt may start: recording, not paused, its part on, its shot real. */
  private async mayStart(
    tx: Tx,
    status: string,
    input: Mark,
    session: { shotCount: number; partOpen: boolean },
  ) {
    this.stillRecording(status);
    if (await this.recordings.openPause(tx, input.sessionId)) {
      throw new AppError("RECORDING_PAUSED");
    }
    if (!session.partOpen) {
      throw new AppError("RECORDING_PART_CLOSED");
    }
    if (input.shotIndex >= session.shotCount) {
      throw new AppError("DIRECTOR_SHOT_NOT_FOUND");
    }
    if (input.attempt <= (await this.recordings.lastAttemptNumber(tx, input.sessionId))) {
      throw new AppError("RECORDING_MARK_OUT_OF_ORDER");
    }
    // An attempt is one start in a part (the post-session pass relies on it to add each
    // it finds once): a second start at the very same moment is out of order too.
    if (await this.recordings.attemptStartsAt(tx, input.sessionId, input.partIndex, input.atMs)) {
      throw new AppError("RECORDING_MARK_OUT_OF_ORDER");
    }
  }

  private async startAttempt(tx: Tx, orgId: OrgId, input: Mark) {
    const open = await this.recordings.openAttempt(tx, input.sessionId);
    if (open) {
      await this.recordings.endAttempt(
        tx,
        recordingAttemptIdSchema.parse(open.id),
        endOf(open, input),
      );
    }
    return this.recordings.startAttempt(tx, {
      orgId,
      sessionId: input.sessionId,
      number: input.attempt,
      shotIndex: input.shotIndex,
      partIndex: input.partIndex,
      startMs: input.atMs,
      line: input.line ?? null,
      note: input.note ?? null,
    });
  }

  /**
   * Ends the attempt the mark names, and only it: the same end sent again answers it as
   * it ended, and an end for an attempt that isn't open (a newer one is) changes nothing.
   */
  private async endAttempt(
    tx: Tx,
    input: Mark,
    attempt: Awaited<ReturnType<RecordingRepository["attemptNumbered"]>>,
  ) {
    if (attempt && attempt.status !== "open") {
      return attempt;
    }
    if (!attempt) {
      throw new AppError("RECORDING_ATTEMPT_NOT_OPEN");
    }
    return this.recordings.endAttempt(
      tx,
      recordingAttemptIdSchema.parse(attempt.id),
      endOf(attempt, input),
      input.note,
    );
  }

  /**
   * Sends every ended attempt of the session whose footage is all stored to the clipper.
   * Queued before it's marked: an attempt queued twice is cut once (its id is the job's),
   * and one marked but never queued would wait forever.
   */
  private async clipReady({ orgId, userId }: Caller, sessionId: RecordingSessionId) {
    const waiting = await this.recordings.waitingAttempts(orgId, sessionId);
    if (waiting.length === 0) {
      return;
    }
    const { parts } = await this.recordings.footage(orgId, sessionId);
    const meta = { requestId: currentContext()?.requestId, userId, orgId };
    for (const attempt of readyAttempts(waiting, parts)) {
      const attemptId = recordingAttemptIdSchema.parse(attempt.id);
      await this.queue.add("clip", { attemptId, orgId }, { jobId: attemptId, meta });
      await this.recordings.clipping(orgId, attemptId);
    }
  }
}
