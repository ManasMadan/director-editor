/**
 * Data access for Director's recording sessions (app schema, this API's own). Every query
 * is scoped to the workspace by row-level security (withTenant, or the Tx of a tenantTx
 * the service opens) and names the member, whose sessions are theirs alone.
 */
import { Injectable } from "@nestjs/common";
import type {
  DirectorTakeId,
  OrgId,
  RecordingAttemptId,
  RecordingSessionId,
  UserId,
} from "@repo/contracts/ids";
import { RECORDING_MAX_BITS_PER_SECOND } from "@repo/contracts/recording";
import { type Tx, withTenant } from "@repo/db";
import { type Database, InjectDatabase, row } from "@repo/nest-common";
import * as z from "zod";

const sessionSelect = {
  id: true,
  videoId: true,
  shotCount: true,
  status: true,
  demo: true,
  recordedMs: true,
  bytes: true,
  createdAt: true,
  finishedAt: true,
  expiresAt: true,
  // An open pause: one not resumed yet.
  pauses: { where: { resumedAt: null }, select: { partIndex: true, startMs: true }, take: 1 },
} as const;

const attemptSelect = {
  id: true,
  number: true,
  shotIndex: true,
  partIndex: true,
  line: true,
  note: true,
  startMs: true,
  endMs: true,
  status: true,
  clipStartMs: true,
  clipEndMs: true,
  takeId: true,
  fileId: true,
  error: true,
  createdAt: true,
} as const;

const partSelect = {
  index: true,
  camera: true,
  contentType: true,
  sliceCount: true,
  slices: {
    select: { index: true, startMs: true, durationMs: true, size: true, status: true },
    orderBy: { index: "asc" },
  },
} as const;

const total = z.object({ n: z.coerce.number() });
const locked = z.object({ status: z.string() });

@Injectable()
export class RecordingRepository {
  constructor(@InjectDatabase() private readonly database: Database) {}

  private read(orgId: OrgId) {
    return withTenant(this.database.read, orgId);
  }

  private write(orgId: OrgId) {
    return withTenant(this.database.write, orgId);
  }

  /**
   * The member's raw footage in the workspace, in bytes: every slice signed, stored or
   * not. In `tx`, under lockFootage, so two uploads at once can't both fit the last space.
   */
  async footageBytes(tx: Tx, userId: UserId) {
    const { n } = await row(
      total,
      tx.$queryRaw`
        SELECT coalesce(sum(sl.size), 0) AS n
          FROM app.recording_slice sl
          JOIN app.recording_session s ON s.id = sl.session_id
         WHERE s.user_id = ${userId}::uuid`,
    );
    return n;
  }

  /**
   * A session's footage so far, as the server counts it (`countedMs` in packages/contracts
   * recording.ts): each slice's duration, or longer when its size couldn't have been
   * recorded in less. Every slice signed, stored or not.
   */
  async countedMs(tx: Tx, sessionId: RecordingSessionId) {
    const { n } = await row(
      total,
      tx.$queryRaw`
        SELECT coalesce(sum(greatest(duration_ms,
                 ceil(size * 8000.0 / ${RECORDING_MAX_BITS_PER_SECOND}))), 0) AS n
          FROM app.recording_slice WHERE session_id = ${sessionId}::uuid`,
    );
    return n;
  }

  /**
   * Holds the member's footage for the rest of the transaction: their uploads' limits are
   * checked and signed one at a time, across every session of theirs.
   */
  async lockFootage(tx: Tx, userId: UserId) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('recording-footage:' || ${userId}))`;
  }

  createSession(
    orgId: OrgId,
    data: {
      userId: UserId;
      planId: string;
      videoId: string;
      shotCount: number;
      demo: boolean;
      expiresAt: Date;
    },
  ) {
    return this.write(orgId).recordingSession.create({
      data: { ...data, orgId },
      select: sessionSelect,
    });
  }

  sessions(orgId: OrgId, userId: UserId) {
    return this.read(orgId).recordingSession.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: sessionSelect,
    });
  }

  session(orgId: OrgId, userId: UserId, sessionId: RecordingSessionId) {
    return this.read(orgId).recordingSession.findFirst({
      where: { id: sessionId, userId },
      select: sessionSelect,
    });
  }

  /** A session's parts with their slices, and its attempts, in order. */
  async footage(orgId: OrgId, sessionId: RecordingSessionId) {
    const db = this.read(orgId);
    const [parts, attempts] = await Promise.all([
      db.recordingPart.findMany({
        where: { sessionId },
        orderBy: { index: "asc" },
        select: partSelect,
      }),
      db.recordingAttempt.findMany({
        where: { sessionId },
        orderBy: { number: "asc" },
        select: attemptSelect,
      }),
    ]);
    return { parts, attempts };
  }

  part(orgId: OrgId, sessionId: RecordingSessionId, index: number) {
    return this.read(orgId).recordingPart.findUnique({
      where: { sessionId_index: { sessionId, index } },
      select: partSelect,
    });
  }

  /** Adds a part, or leaves the one with that index as it is: the part at the index after. */
  async addPart(
    orgId: OrgId,
    data: { sessionId: RecordingSessionId; index: number; camera: string; contentType: string },
  ) {
    await this.write(orgId).recordingPart.createMany({
      data: [{ ...data, orgId }],
      skipDuplicates: true,
    });
    return this.part(orgId, data.sessionId, data.index);
  }

  async closePart(orgId: OrgId, sessionId: RecordingSessionId, index: number, sliceCount: number) {
    await this.write(orgId).recordingPart.updateMany({
      where: { sessionId, index, sliceCount: null },
      data: { sliceCount },
    });
  }

  slice(orgId: OrgId, sessionId: RecordingSessionId, partIndex: number, index: number) {
    return this.read(orgId).recordingSlice.findUnique({
      where: { sessionId_partIndex_index: { sessionId, partIndex, index } },
      select: { startMs: true, durationMs: true, size: true, status: true },
    });
  }

  /** Records a slice as signed, or what a slice signed again (not yet stored) now is. */
  async signSlice(
    tx: Tx,
    data: {
      orgId: OrgId;
      sessionId: RecordingSessionId;
      partIndex: number;
      index: number;
      startMs: number;
      durationMs: number;
      size: number;
    },
  ) {
    const { sessionId, partIndex, index, orgId: _orgId, ...slice } = data;
    await tx.recordingSlice.upsert({
      where: { sessionId_partIndex_index: { sessionId, partIndex, index } },
      create: data,
      update: slice,
    });
  }

  /**
   * Marks a signed slice stored and counts it on its session, in one statement: a second
   * completion, or one racing it, finds it stored already and counts nothing.
   */
  async storeSlice(
    tx: Tx,
    slice: { sessionId: RecordingSessionId; partIndex: number; index: number },
  ) {
    await tx.$executeRaw`
      WITH stored AS (
        UPDATE app.recording_slice
           SET status = 'uploaded', uploaded_at = now()
         WHERE session_id = ${slice.sessionId}::uuid AND part_index = ${slice.partIndex}
           AND index = ${slice.index} AND status = 'pending'
        RETURNING greatest(duration_ms,
                    ceil(size * 8000.0 / ${RECORDING_MAX_BITS_PER_SECOND}))::int AS counted,
                  size)
      UPDATE app.recording_session
         SET recorded_ms = recorded_ms + coalesce((SELECT sum(counted) FROM stored), 0),
             bytes = bytes + coalesce((SELECT sum(size) FROM stored), 0),
             updated_at = now()
       WHERE id = ${slice.sessionId}::uuid`;
  }

  /** A stored slice that isn't kept after all (its bytes weren't a recording). */
  async dropSlice(
    orgId: OrgId,
    slice: { sessionId: RecordingSessionId; partIndex: number; index: number },
  ) {
    await this.write(orgId).recordingSlice.deleteMany({ where: slice });
  }

  /**
   * Holds the session for the rest of the transaction (its marks, pauses and Done one at
   * a time), and answers its status as it is now.
   */
  async lockSession(tx: Tx, sessionId: RecordingSessionId) {
    const { status } = await row(
      locked,
      tx.$queryRaw`SELECT status FROM app.recording_session WHERE id = ${sessionId}::uuid FOR UPDATE`,
    );
    return status;
  }

  openAttempt(tx: Tx, sessionId: RecordingSessionId) {
    return tx.recordingAttempt.findFirst({
      where: { sessionId, status: "open" },
      select: attemptSelect,
    });
  }

  attemptNumbered(tx: Tx, sessionId: RecordingSessionId, number: number) {
    return tx.recordingAttempt.findUnique({
      where: { sessionId_number: { sessionId, number } },
      select: attemptSelect,
    });
  }

  async lastAttemptNumber(tx: Tx, sessionId: RecordingSessionId) {
    const { _max } = await tx.recordingAttempt.aggregate({
      where: { sessionId },
      _max: { number: true },
    });
    return _max.number ?? 0;
  }

  /** Whether an attempt already starts at this moment of the part (one per start). */
  async attemptStartsAt(tx: Tx, sessionId: RecordingSessionId, partIndex: number, startMs: number) {
    const found = await tx.recordingAttempt.findUnique({
      where: { sessionId_partIndex_startMs: { sessionId, partIndex, startMs } },
      select: { id: true },
    });
    return found !== null;
  }

  startAttempt(
    tx: Tx,
    data: {
      orgId: OrgId;
      sessionId: RecordingSessionId;
      number: number;
      shotIndex: number;
      partIndex: number;
      startMs: number;
      line: string | null;
      note: string | null;
    },
  ) {
    return tx.recordingAttempt.create({ data, select: attemptSelect });
  }

  /** Ends an open attempt at `endMs` (null: its part's end); it then waits for its footage. */
  endAttempt(tx: Tx, attemptId: RecordingAttemptId, endMs: number | null, note?: string) {
    return tx.recordingAttempt.update({
      where: { id: attemptId },
      data: { endMs, status: "waiting", ...(note !== undefined && { note }) },
      select: attemptSelect,
    });
  }

  openPause(tx: Tx, sessionId: RecordingSessionId) {
    return tx.recordingPause.findFirst({
      where: { sessionId, resumedAt: null },
      select: { partIndex: true, startMs: true },
    });
  }

  async pause(
    tx: Tx,
    data: { orgId: OrgId; sessionId: RecordingSessionId; partIndex: number; startMs: number },
  ) {
    await tx.recordingPause.createMany({ data: [data], skipDuplicates: true });
    // The session changed: what keeps it from being taken for one left idle.
    await tx.recordingSession.update({
      where: { id: data.sessionId },
      data: { updatedAt: new Date() },
    });
  }

  async resume(
    tx: Tx,
    pause: { sessionId: RecordingSessionId; partIndex: number; startMs: number },
    endMs: number | null,
  ) {
    await tx.recordingPause.update({
      where: { sessionId_partIndex_startMs: pause },
      data: { endMs, resumedAt: new Date() },
    });
    await tx.recordingSession.update({
      where: { id: pause.sessionId },
      data: { updatedAt: new Date() },
    });
  }

  async finish(tx: Tx, sessionId: RecordingSessionId) {
    await tx.recordingSession.updateMany({
      where: { id: sessionId, status: "recording" },
      data: { status: "done", finishedAt: new Date() },
    });
  }

  /** Whether the session is done and its post-session pass not queued yet. */
  async passDue(orgId: OrgId, sessionId: RecordingSessionId) {
    const due = await this.read(orgId).recordingSession.count({
      where: { id: sessionId, status: "done", passQueuedAt: null },
    });
    return due > 0;
  }

  async passQueued(orgId: OrgId, sessionId: RecordingSessionId) {
    await this.write(orgId).recordingSession.updateMany({
      where: { id: sessionId, passQueuedAt: null },
      data: { passQueuedAt: new Date() },
    });
  }

  /** Ended attempts whose footage isn't at the clipper yet. */
  waitingAttempts(orgId: OrgId, sessionId: RecordingSessionId) {
    return this.read(orgId).recordingAttempt.findMany({
      where: { sessionId, status: "waiting" },
      orderBy: { number: "asc" },
      select: { id: true, partIndex: true, endMs: true },
    });
  }

  async clipping(orgId: OrgId, attemptId: RecordingAttemptId) {
    await this.write(orgId).recordingAttempt.updateMany({
      where: { id: attemptId, status: "waiting" },
      data: { status: "clipping" },
    });
  }

  /**
   * Deletes a session in one statement: its slices' objects are queued for deletion from
   * storage, and its attempts' take files are deleted with their takes (both by trigger).
   */
  async remove(orgId: OrgId, userId: UserId, sessionId: RecordingSessionId) {
    await this.write(orgId).recordingSession.deleteMany({ where: { id: sessionId, userId } });
  }

  /**
   * Keeps the footage of the member's sessions that takes `takeIds` were cut from for
   * another `keepDays` from now, up to `maxDays` after each was recorded. The demo's
   * footage keeps its 24 hours.
   */
  async keep(
    tx: Tx,
    userId: UserId,
    takeIds: readonly DirectorTakeId[],
    keepDays: number,
    maxDays: number,
  ) {
    await tx.$executeRaw`
      UPDATE app.recording_session s
         SET expires_at = least(s.created_at + make_interval(days => ${maxDays}::int),
                                now() + make_interval(days => ${keepDays}::int)),
             updated_at = now()
       WHERE s.user_id = ${userId}::uuid AND NOT s.demo
         AND s.id IN (SELECT a.session_id FROM app.recording_attempt a
                       WHERE a.take_id = ANY (${takeIds}::uuid[]))`;
  }
}
