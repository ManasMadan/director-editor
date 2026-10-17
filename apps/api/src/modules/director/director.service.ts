/**
 * Director, on top of the AI service (apps/ai/app/director.py), which owns the plans,
 * takes and cuts and calls Gemini. This API checks what only it can: that a pasted link
 * is a short on YouTube (ShortsService), that a take's or a cut's file is the caller's,
 * checked and of the right kind (FilesService), whose presigned read it hands the AI
 * service for a take's review, and the short-lived links to a plan's stored audio.
 */
import { Injectable } from "@nestjs/common";
import {
  type DirectorCut,
  type DirectorLibrary,
  type DirectorPlan,
  type DirectorShot,
  type DirectorTake,
  directorCutSchema,
  directorPlanSchema,
  directorTakeSchema,
  type SceneCheck,
  sceneCheckSchema,
} from "@repo/contracts/api";
import type { UploadPurpose } from "@repo/contracts/files";
import type { FileId, OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { HOUR_S, MINUTE_S } from "@repo/contracts/time";
import { AppError } from "@repo/nest-common";
import * as z from "zod";
import { aiCaller, callAi } from "../ai";
import { FilesService } from "../files";
import { ShortsService } from "../shorts";
import { shotsOf } from "./shots";

// Long enough for the review job's retries (three, minutes apart), no longer.
const TAKE_READ_EXPIRES_S = 30 * MINUTE_S;
// Long enough to film along to it for a while; the library is read again before then.
const AUDIO_READ_EXPIRES_S = HOUR_S;

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};
// What the worker stores a take as (apps/worker files processor).
const takeContentType = z.enum(["video/webm", "video/mp4", "image/jpeg"]);

// The AI service's JSON carries dates as strings; the contract's schemas want Dates. A
// plan's audio comes as its stored object's key, which only this API turns into a link.
const wirePlan = directorPlanSchema.omit({ audio: true }).extend({
  audioStatus: directorPlanSchema.shape.audio.shape.status,
  audioKey: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
const wireTake = directorTakeSchema.extend({ createdAt: z.coerce.date() });
const wireCut = directorCutSchema.omit({ picks: true, publish: true }).extend({
  picks: z.array(z.object({ shotIndex: z.number().int(), takeId: directorTakeSchema.shape.id })),
  publishStatus: directorCutSchema.shape.publish.shape.status,
  youtubeVideoId: z.string().nullable(),
  visibility: directorCutSchema.shape.publish.shape.visibility,
  createdAt: z.coerce.date(),
});

function toCut(row: unknown): DirectorCut {
  const { picks, publishStatus, youtubeVideoId, visibility, ...cut } = wireCut.parse(row);
  return {
    ...cut,
    picks: Object.fromEntries(picks.map((pick) => [pick.shotIndex, pick.takeId])),
    publish: { status: publishStatus, youtubeVideoId, visibility },
  };
}

@Injectable()
export class DirectorService {
  constructor(
    private readonly shorts: ShortsService,
    private readonly files: FilesService,
  ) {}

  async library(userId: UserId, orgId: OrgId): Promise<DirectorLibrary> {
    const { templates, indexUsed } = await callAi((ai) =>
      ai.director.library(aiCaller(userId, orgId)),
    );
    return { templates: await Promise.all(templates.map((plan) => this.toPlan(plan))), indexUsed };
  }

  /** Indexes the short a link points at, once it's known to be one Director can film. */
  async index(userId: UserId, orgId: OrgId, url: string): Promise<DirectorPlan> {
    const { videoId } = await this.shorts.filmable(url);
    return this.toPlan(await callAi((ai) => ai.director.index(aiCaller(userId, orgId), videoId)));
  }

  async plan(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorPlan> {
    return this.toPlan(await callAi((ai) => ai.director.getPlan(aiCaller(userId, orgId), videoId)));
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
    return wireTake.parse(row);
  }

  /** Each shot of a ready plan with the caller's takes of it, the pick and the retakes. */
  async shots(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorShot[]> {
    const [plan, takes] = await Promise.all([
      this.plan(userId, orgId, videoId),
      this.takes(userId, orgId, videoId),
    ]);
    if (plan.status !== "ready" || !plan.plan) {
      throw new AppError("DIRECTOR_PLAN_NOT_READY");
    }
    return shotsOf(plan.plan.shots.length, takes);
  }

  async cuts(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorCut[]> {
    const rows = await callAi((ai) => ai.director.listCuts(aiCaller(userId, orgId), videoId));
    return rows.map(toCut);
  }

  async media(userId: UserId, orgId: OrgId): Promise<DirectorCut[]> {
    const rows = await callAi((ai) => ai.director.listMedia(aiCaller(userId, orgId)));
    return rows.map(toCut);
  }

  /** Saves a cut whose rendered video is a ready `director-cut-video` upload of the caller's. */
  async saveCut(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; picks: DirectorCut["picks"]; fileId: FileId; title: string },
  ): Promise<DirectorCut> {
    await this.files.ready(userId, input.fileId, "director-cut-video");
    const row = await callAi((ai) =>
      ai.director.createCut(aiCaller(userId, orgId), {
        videoId: input.videoId,
        title: input.title,
        fileId: input.fileId,
        picks: Object.entries(input.picks).map(([shotIndex, takeId]) => ({
          shotIndex: Number(shotIndex),
          takeId,
        })),
      }),
    );
    return toCut(row);
  }

  private async toPlan(row: unknown): Promise<DirectorPlan> {
    const { audioStatus, audioKey, ...plan } = wirePlan.parse(row);
    const url =
      audioStatus === "ready" && audioKey
        ? await this.files.objectUrl(audioKey, AUDIO_READ_EXPIRES_S)
        : null;
    return { ...plan, audio: { status: audioStatus, url } };
  }
}
