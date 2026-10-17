/**
 * Director, on top of the AI service (apps/ai/app/director.py), which owns the plans and
 * takes and calls Gemini. This API checks what only it can: that the short exists on
 * YouTube and is short enough (ShortsService), and that a take's file is the caller's,
 * checked and of the right kind (FilesService), whose presigned read it hands the AI
 * service for the review.
 */
import { Injectable } from "@nestjs/common";
import {
  type DirectorPlan,
  type DirectorTake,
  directorPlanSchema,
  directorTakeSchema,
  type SceneCheck,
  sceneCheckSchema,
} from "@repo/contracts/api";
import type { UploadPurpose } from "@repo/contracts/files";
import type { FileId, OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { MINUTE_S } from "@repo/contracts/time";
import { AppError } from "@repo/nest-common";
import * as z from "zod";
import { aiCaller, callAi } from "../ai";
import { AnalyticsService } from "../analytics";
import { FilesService } from "../files";
import { ShortsService } from "../shorts";

// Long enough for the review job's retries (three, minutes apart), no longer.
const TAKE_READ_EXPIRES_S = 30 * MINUTE_S;

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};
// What the worker stores a take as (apps/worker files processor).
const takeContentType = z.enum(["video/webm", "video/mp4", "image/jpeg"]);

// The AI service's JSON carries dates as strings; the contract's schemas want Dates.
const wirePlan = directorPlanSchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
const wireTake = directorTakeSchema.extend({ createdAt: z.coerce.date() });

@Injectable()
export class DirectorService {
  constructor(
    private readonly shorts: ShortsService,
    private readonly files: FilesService,
    private readonly analytics: AnalyticsService,
  ) {}

  async plan(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorPlan> {
    return wirePlan.parse(
      await callAi((ai) => ai.director.getPlan(aiCaller(userId, orgId), videoId)),
    );
  }

  /** Asks for a plan, once the short is known to exist and to be one. */
  async requestPlan(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorPlan> {
    await this.shorts.filmable(videoId);
    return wirePlan.parse(
      await callAi((ai) => ai.director.requestPlan(aiCaller(userId, orgId), videoId)),
    );
  }

  async checkScene(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; shotIndex: number; image: string },
  ): Promise<SceneCheck> {
    return sceneCheckSchema.parse(
      await callAi((ai) => ai.director.checkScene(aiCaller(userId, orgId), input)),
    );
  }

  async takes(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorTake[]> {
    const rows = await callAi((ai) => ai.director.listTakes(aiCaller(userId, orgId), videoId));
    return rows.map((row) => wireTake.parse(row));
  }

  /** Records a take from a ready upload of the caller's, of the kind the shot needs. */
  async addTake(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; shotIndex: number; kind: DirectorTake["kind"]; fileId: FileId },
  ): Promise<DirectorTake> {
    const { file, url } = await this.files.readUrl(
      userId,
      input.fileId,
      PURPOSE[input.kind],
      TAKE_READ_EXPIRES_S,
    );
    const contentType = takeContentType.safeParse(file.contentType);
    if (!contentType.success) {
      // A ready file of a take's purpose always has one of these types.
      throw new AppError("FILE_NOT_FOUND");
    }
    const row = await callAi((ai) =>
      ai.director.createTake(aiCaller(userId, orgId), {
        ...input,
        contentType: contentType.data,
        sourceUrl: url,
      }),
    );
    // The AI service reviews it asynchronously and doesn't report completion back here
    // (apps/ai/app/director.py owns the take and its score); this counts the take
    // entering review, for the volume side of the Looker report.
    this.analytics.record("take_reviewed", { userId, videoId: input.videoId });
    return wireTake.parse(row);
  }
}
