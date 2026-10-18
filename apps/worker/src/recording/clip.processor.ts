/**
 * Cuts an ended attempt of Director's continuous recording into a take (the `recording`
 * queue's `clip` job, queued by apps/api once all its footage is stored, or by the
 * maintenance task that finishes sessions left open):
 *
 *   1. the attempt's part's slices, from the first to the last it needs, are signed for
 *      reading and handed to the AI service's clipper with Director's marks and the
 *      part's pauses (the clipper snaps the marks to the first and last words, and never
 *      cuts across a pause);
 *   2. the MP4 it answers is stored as a file of the member's (`director-take-video`,
 *      `files/<id>`): its own re-encode, so it skips the uploads' scan and type check;
 *   3. the AI service records it as a take of the shot, which queues Gemini's review;
 *   4. the attempt says where it was cut and which take it became, and the member's
 *      screens are nudged (`recording.changed`).
 *
 * Every step can run again: the file is the attempt's (made once, kept on the attempt),
 * storing it again overwrites the same bytes, and the AI service answers a file it has
 * already taken with that take. An attempt that can't be cut fails with
 * RECORDING_CLIP_FAILED (or the AI service's reason a take can't be made of it); a
 * clipper outage is retried, and fails the attempt once the job's attempts are spent.
 *
 * The member may delete the session while it's being cut. The attempt's file is made in
 * the transaction that sets it on the attempt, under the attempt's row lock, and only if
 * the attempt is still there; from then on deleting the attempt deletes the file (a
 * trigger), and the take with it.
 * So whichever comes first, nothing of a deleted session is left: a cut that finds its
 * attempt gone stops, and deletes the bytes it may have stored after the file went.
 */
import { createHash, randomUUID } from "node:crypto";
import { Processor } from "@nestjs/bullmq";
import { Inject } from "@nestjs/common";
import { AiServiceError, type createAiClient } from "@repo/ai-client";
import { uploadPurposes } from "@repo/contracts/files";
import {
  type FileId,
  fileIdSchema,
  type OrgId,
  type RecordingAttemptId,
  userIdSchema,
} from "@repo/contracts/ids";
import { realtimeChannel } from "@repo/contracts/realtime";
import { footageThrough, RECORDING_TYPES, recordingSliceKey } from "@repo/contracts/recording";
import { MINUTE_S } from "@repo/contracts/time";
import { tenantTx, withTenant } from "@repo/db";
import { parseJob, queuePrefix, queues, TAKE_REVIEW_READ_S, type UncheckedJob } from "@repo/jobs";
import {
  type Database,
  InjectDatabase,
  InjectPinoLogger,
  InjectRedis,
  JobProcessor,
  PinoLogger,
  type Redis,
  rows,
  runJob,
  STORAGE,
  type Storage,
} from "@repo/nest-common";
import * as z from "zod";
import { env } from "../env";
import { publishRealtime } from "../realtime/publish";

export const AI_CLIENT = Symbol("AI_CLIENT");
export type AiClient = ReturnType<typeof createAiClient>;

// Long enough for the clipper to fetch a whole part on a retry, no longer.
const READ_EXPIRES_S = 30 * MINUTE_S;
const TAKE_TYPE = "video/mp4";
const recordingType = z.enum(RECORDING_TYPES);
// What the AI service answers when a take can't be made of an attempt: its reason is
// the attempt's (the shot isn't a video shot, the plan is gone).
const TAKE_REFUSALS = new Set([
  "RECORDING_CLIP_FAILED",
  "DIRECTOR_PLAN_NOT_FOUND",
  "DIRECTOR_PLAN_NOT_READY",
  "DIRECTOR_SHOT_NOT_FOUND",
  "DIRECTOR_TAKE_KIND_MISMATCH",
]);

/** An attempt whose footage isn't all stored yet: a retry finds it there. */
class FootageMissing extends Error {}

/** An attempt in a part that ended without a single slice: there's nothing to cut. */
class NoFootage extends Error {}

/** The attempt was deleted (with its session) while it was being cut. */
class AttemptGone extends Error {}

/** An attempt's row, locked: the file it has. */
const lockedAttempt = z.object({ file_id: fileIdSchema.nullable() });

/** Why an attempt can never become a take, or null when trying again may yet work. */
function refusal(error: unknown): string | null {
  if (error instanceof NoFootage) {
    return "RECORDING_CLIP_FAILED";
  }
  if (error instanceof AiServiceError && TAKE_REFUSALS.has(error.code)) {
    return error.code;
  }
  return null;
}

/** What cutting an attempt reads of it. */
interface Attempt {
  id: string;
  number: number;
  shotIndex: number;
  partIndex: number;
  startMs: number;
  endMs: number | null;
  status: string;
  sessionId: string;
  session: { userId: string; videoId: string };
}

@Processor("recording", {
  concurrency: env.RECORDING_CONCURRENCY,
  prefix: queuePrefix("recording"),
})
export class ClipProcessor extends JobProcessor {
  constructor(
    @InjectDatabase() private readonly database: Database,
    @Inject(STORAGE) private readonly storage: Storage | null,
    @Inject(AI_CLIENT) private readonly ai: AiClient | null,
    @InjectRedis() private readonly redis: Redis,
    @InjectPinoLogger(ClipProcessor.name) private readonly log: PinoLogger,
  ) {
    super();
  }

  async process(job: UncheckedJob) {
    const { meta, payload } = parseJob("recording", "clip", job.data);
    // The queue's own tries (packages/jobs), as the producer gave the job.
    const final = job.attemptsMade + 1 >= queues.recording.options.attempts;
    await runJob(meta, `job:${job.id}`, () => this.clip(payload.orgId, payload.attemptId, final));
  }

  /** Cuts the attempt into a take; `final` is the job's last try. */
  async clip(orgId: OrgId, attemptId: RecordingAttemptId, final = true) {
    if (!this.storage || !this.ai) {
      throw new Error("recording needs storage and the AI service (AI_URL) to cut takes");
    }
    const attempt = await this.attempt(orgId, attemptId);
    if (!attempt || attempt.status === "clipped" || attempt.status === "failed") {
      // Gone with its session, or done already by an earlier run.
      return;
    }
    try {
      await this.cut(this.storage, this.ai, orgId, attempt);
    } catch (error) {
      if (error instanceof AttemptGone) {
        this.log.info({ attemptId: attempt.id }, "attempt deleted while it was cut");
        return;
      }
      const refused = refusal(error);
      if (refused || final) {
        await this.fail(orgId, attempt, refused ?? "RECORDING_CLIP_FAILED");
      }
      if (!refused) {
        throw error;
      }
    }
  }

  private attempt(orgId: OrgId, attemptId: RecordingAttemptId): Promise<Attempt | null> {
    return withTenant(this.database.write, orgId).recordingAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        number: true,
        shotIndex: true,
        partIndex: true,
        startMs: true,
        endMs: true,
        status: true,
        sessionId: true,
        session: { select: { userId: true, videoId: true } },
      },
    });
  }

  private async cut(storage: Storage, ai: AiClient, orgId: OrgId, attempt: Attempt) {
    const caller = { userId: attempt.session.userId, orgId };
    const clip = await ai.director.clip(caller, await this.request(storage, orgId, attempt));
    const fileId = await this.storeTake(storage, orgId, attempt, Buffer.from(clip.video));
    // The take's review reads it, maybe behind a backlog and after minutes of retries.
    const { url } = await storage.presignDownload(`files/${fileId}`, {
      expiresInSeconds: TAKE_REVIEW_READ_S,
    });
    const take = await ai.director.createTake(caller, {
      videoId: attempt.session.videoId,
      shotIndex: attempt.shotIndex,
      kind: "video",
      fileId,
      contentType: TAKE_TYPE,
      sourceUrl: url,
    });
    const { count } = await withTenant(this.database.write, orgId).recordingAttempt.updateMany({
      where: { id: attempt.id },
      data: {
        status: "clipped",
        clipStartMs: clip.startMs,
        clipEndMs: clip.endMs,
        takeId: take.id,
        error: null,
      },
    });
    if (count === 0) {
      // Deleted since the take was made: its file went with it, and the take with that.
      throw new AttemptGone(attempt.id);
    }
    this.log.info({ attemptId: attempt.id, takeId: take.id }, "attempt clipped");
    await this.nudge(attempt.session.userId);
  }

  /**
   * What the clipper gets: the part's slices from its first to the last the attempt
   * needs, as presigned reads, Director's marks and the part's pauses.
   */
  private async request(storage: Storage, orgId: OrgId, attempt: Attempt) {
    const db = withTenant(this.database.write, orgId);
    const [part, pauses] = await Promise.all([
      db.recordingPart.findUniqueOrThrow({
        where: { sessionId_index: { sessionId: attempt.sessionId, index: attempt.partIndex } },
        select: {
          contentType: true,
          sliceCount: true,
          slices: { select: { index: true, startMs: true, durationMs: true, status: true } },
        },
      }),
      db.recordingPause.findMany({
        where: { sessionId: attempt.sessionId, partIndex: attempt.partIndex },
        select: { startMs: true, endMs: true },
      }),
    ]);
    if (part.sliceCount === 0) {
      throw new NoFootage(`attempt ${attempt.id}'s part has no footage`);
    }
    const slices = part.slices
      .map((slice) => ({ ...slice, uploaded: slice.status === "uploaded" }))
      .sort((a, b) => a.index - b.index);
    const through = footageThrough(slices, attempt.endMs, part.sliceCount);
    if (through === null) {
      throw new FootageMissing(`attempt ${attempt.id}'s footage isn't all stored yet`);
    }
    const signed = await Promise.all(
      slices.slice(0, through + 1).map(async (slice) => {
        const key = recordingSliceKey(attempt.sessionId, attempt.partIndex, slice.index);
        const { url } = await storage.presignDownload(key, { expiresInSeconds: READ_EXPIRES_S });
        return { url, startMs: slice.startMs, durationMs: slice.durationMs };
      }),
    );
    return {
      attemptId: attempt.id,
      contentType: recordingType.parse(part.contentType),
      slices: signed,
      startMs: attempt.startMs,
      endMs: attempt.endMs,
      pauses,
    };
  }

  /**
   * The take's file: made once for the attempt (processing), its bytes stored, then
   * ready. A retry finds the attempt's file and stores the same bytes again.
   */
  private async storeTake(
    storage: Storage,
    orgId: OrgId,
    attempt: Attempt,
    video: Buffer,
  ): Promise<FileId> {
    const fileId = await this.fileOf(orgId, attempt);
    const key = `files/${fileId}`;
    await storage.write(key, video, TAKE_TYPE);
    const { count } = await this.database.write.file.updateMany({
      where: { id: fileId },
      data: {
        status: "ready",
        contentType: TAKE_TYPE,
        size: video.length,
        sha256: createHash("sha256").update(video).digest("hex"),
        readyAt: new Date(),
      },
    });
    if (count === 0) {
      // Deleted with its attempt while the bytes were on their way: the deletion queued
      // the object before it was written, so these bytes are this run's to delete.
      await storage.delete(key);
      throw new AttemptGone(attempt.id);
    }
    return fileId;
  }

  /**
   * The attempt's file: the one it has (an earlier run's, or another run's that got
   * there first), or one made and set on it in the same transaction, under the attempt's
   * row lock. Gone, the attempt gets none, and the cut stops.
   */
  private async fileOf(orgId: OrgId, attempt: Attempt): Promise<FileId> {
    const fileId = await tenantTx(this.database.write, orgId, async (tx) => {
      const [locked] = await rows(
        lockedAttempt,
        tx.$queryRaw`SELECT file_id FROM app.recording_attempt WHERE id = ${attempt.id}::uuid FOR UPDATE`,
      );
      if (!locked || locked.file_id !== null) {
        return locked?.file_id ?? null;
      }
      const made = fileIdSchema.parse(randomUUID());
      await tx.file.create({
        data: {
          id: made,
          userId: attempt.session.userId,
          purpose: "director-take-video",
          status: "processing",
          filename: `attempt-${attempt.number}.mp4`,
          declaredType: TAKE_TYPE,
          declaredSize: uploadPurposes["director-take-video"].maxBytes,
        },
        select: { id: true },
      });
      await tx.recordingAttempt.update({ where: { id: attempt.id }, data: { fileId: made } });
      return made;
    });
    if (fileId === null) {
      throw new AttemptGone(attempt.id);
    }
    return fileId;
  }

  private async fail(orgId: OrgId, attempt: Attempt, code: string) {
    // Gone already (the session deleted meanwhile): nothing to record it on.
    await withTenant(this.database.write, orgId).recordingAttempt.updateMany({
      where: { id: attempt.id },
      data: { status: "failed", error: code },
    });
    this.log.warn({ attemptId: attempt.id, code }, "attempt couldn't be clipped");
    await this.nudge(attempt.session.userId);
  }

  private nudge(userId: string) {
    return publishRealtime(this.redis, realtimeChannel.user(userIdSchema.parse(userId)), {
      type: "recording.changed",
    });
  }
}
