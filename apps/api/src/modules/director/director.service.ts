/**
 * Director, on top of the AI service (apps/ai/app/director.py), which owns the plans,
 * takes and cuts and calls Gemini. This API checks what only it can: that a pasted link
 * is a short on YouTube (ShortsService), that a take's or a cut's file is the caller's,
 * checked and of the right kind (FilesService), whose presigned read it hands the AI
 * service for a take's review, and the short-lived links to a plan's stored audio and to
 * the lines Director speaks (kept in storage, so each is spoken once), and to a
 * template's media (a seed's storyboard cards, preview clips and music, and any plan's
 * asset images).
 */
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  type DirectorChatInput,
  type DirectorChatReply,
  type DirectorCut,
  type DirectorLibrary,
  type DirectorPlan,
  type DirectorShot,
  type DirectorSpeech,
  type DirectorTake,
  type DirectorVoice,
  directorCutSchema,
  directorPlanSchema,
  directorTakeSchema,
  type Located,
  locatedSchema,
  type MatchCutAlignment,
  matchCutAlignmentSchema,
  type SceneCheck,
  type ServedShotPlan,
  type ShotPlan,
  sceneCheckSchema,
  shotPlanSchema,
} from "@repo/contracts/api";
import type { UploadPurpose } from "@repo/contracts/files";
import type {
  DirectorCutId,
  DirectorTakeId,
  FileId,
  OrgId,
  UserId,
  VideoId,
} from "@repo/contracts/ids";
import { HOUR_S, MINUTE_S } from "@repo/contracts/time";
import { AppError, InjectPinoLogger, PinoLogger } from "@repo/nest-common";
import * as z from "zod";
import { env } from "../../env";
import { aiCaller, callAi } from "../ai";
import { FilesService } from "../files";
import { chatUpstream, createGoogleAuth, DirectorChat } from "../live";
import { RecordingService } from "../recording";
import { ShortsService } from "../shorts";
import { type AssetImageRow, planAssetImages, withAssetImages } from "./asset-images";
import { seedAssetImages, seedMediaKeys, withMediaLinks, withSeedAssets } from "./seed-media";
import { shotsOf } from "./shots";

// Long enough for the review job's retries (three, minutes apart), no longer.
const TAKE_READ_EXPIRES_S = 30 * MINUTE_S;
// Long enough to film along to it for a while; the library is read again before then.
const AUDIO_READ_EXPIRES_S = HOUR_S;
// A spoken line is played again and again through a shoot; the screen asks for a fresh
// link once this one is near its end.
const SPEECH_READ_EXPIRES_S = HOUR_S;

/**
 * Where a spoken line is kept: named by the voice and the words, so the same line is
 * spoken once for everyone (every workspace starts with the same seeded templates, and
 * the cues are the same few sentences). A new TTS model keeps the old recordings; bump
 * the prefix's version to have every line spoken afresh.
 */
function speechKey({ text, voice }: { text: string; voice: DirectorVoice }) {
  const digest = createHash("sha256").update(`${voice}\n${text}`).digest("hex");
  return `director/speech/v1/${digest}.wav`;
}
// A seed's storyboard cards, previews and music: signed only for a template's own page
// (director.plan), which is read again before then.
const MEDIA_READ_EXPIRES_S = HOUR_S;

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};
// What the worker stores a take as (apps/worker files processor).
const takeContentType = z.enum(["video/webm", "video/mp4", "image/jpeg"]);

// The AI service's JSON carries dates as strings; the contract's schemas want Dates. A
// plan's audio comes as its stored object's key, which only this API turns into a link.
const wirePlan = directorPlanSchema.omit({ audio: true, plan: true }).extend({
  plan: shotPlanSchema.nullable(),
  audioStatus: directorPlanSchema.shape.audio.shape.status,
  audioKey: z.string().nullable(),
  // An AI service from before asset images reports none.
  assetImages: z
    .array(
      z.object({
        assetId: z.string(),
        status: z.enum(["pending", "generating", "ready", "failed"]),
        objectKey: z.string().nullable(),
      }),
    )
    .default([]),
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
  /** Director's slower line, for when Gemini Live can't run: off without a Google Cloud project. */
  private readonly chatLine: DirectorChat;

  constructor(
    private readonly shorts: ShortsService,
    private readonly files: FilesService,
    private readonly recording: RecordingService,
    @InjectPinoLogger(DirectorService.name) log: PinoLogger,
  ) {
    this.chatLine = new DirectorChat(
      chatUpstream({
        project: env.GOOGLE_CLOUD_PROJECT,
        model: env.CHAT_MODEL,
        url: env.CHAT_API_URL,
        auth: createGoogleAuth(env.GOOGLE_ACCESS_TOKEN),
      }),
      (level, details, message) => log[level](details, message),
    );
  }

  async library(userId: UserId, orgId: OrgId): Promise<DirectorLibrary> {
    const { templates, indexUsed } = await callAi((ai) =>
      ai.director.library(aiCaller(userId, orgId)),
    );
    // Without the seeds' media: dozens of signed links per read (each an IAM call on
    // GCS), for cards no list shows. A template's own page asks for them (plan).
    const plans = templates.map((plan) => this.toPlan(plan, { media: false }));
    return { templates: await Promise.all(plans), indexUsed };
  }

  /** Indexes the short a link points at, once it's known to be one Director can film. */
  async index(userId: UserId, orgId: OrgId, url: string): Promise<DirectorPlan> {
    const { videoId } = await this.shorts.filmable(url);
    const row = await callAi((ai) => ai.director.index(aiCaller(userId, orgId), videoId));
    return this.toPlan(row, { media: false });
  }

  /** A template's own page (director.plan): with a seed's media linked. */
  async plan(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorPlan> {
    return this.toPlan(await this.planRow(userId, orgId, videoId), { media: true });
  }

  /** The plan without its media, for what only needs the shots (the takes, the live call). */
  async planOf(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorPlan> {
    return this.toPlan(await this.planRow(userId, orgId, videoId), { media: false });
  }

  private planRow(userId: UserId, orgId: OrgId, videoId: VideoId) {
    return callAi((ai) => ai.director.getPlan(aiCaller(userId, orgId), videoId));
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

  /** Where a thing Director named is in one camera frame, for a mark on the shoot screen. */
  async locate(
    userId: UserId,
    orgId: OrgId,
    input: { target: string; image: string },
  ): Promise<Located> {
    return locatedSchema.parse(
      await callAi((ai) => ai.director.locate(aiCaller(userId, orgId), input)),
    );
  }

  /**
   * One turn of Director's slower line, on a ready plan's shot (DIRECTOR_PLAN_NOT_FOUND
   * before it's ready). Its reply is spoken with `speak`, like any of Director's lines.
   */
  async chat(userId: UserId, orgId: OrgId, input: DirectorChatInput): Promise<DirectorChatReply> {
    const plan = await this.planOf(userId, orgId, input.videoId);
    if (plan.status !== "ready" || !plan.plan) {
      throw new AppError("DIRECTOR_PLAN_NOT_FOUND");
    }
    return this.chatLine.reply(plan.plan, input);
  }

  /**
   * A line in Director's voice: spoken by the AI service the first time anyone asks for
   * it, kept in storage, and handed back as a short-lived link to the WAV file.
   */
  async speak(
    userId: UserId,
    orgId: OrgId,
    input: { text: string; voice: DirectorVoice },
  ): Promise<DirectorSpeech> {
    return this.files.keptObjectUrl(speechKey(input), "audio/wav", SPEECH_READ_EXPIRES_S, () =>
      callAi((ai) => ai.director.speak(aiCaller(userId, orgId), input)),
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
      this.planOf(userId, orgId, videoId),
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

  /** One of the caller's cuts (DIRECTOR_CUT_NOT_FOUND unless it's theirs). */
  async cut(userId: UserId, orgId: OrgId, cutId: DirectorCutId): Promise<DirectorCut> {
    return toCut(await callAi((ai) => ai.director.getCut(aiCaller(userId, orgId), cutId)));
  }

  async media(userId: UserId, orgId: OrgId): Promise<DirectorCut[]> {
    const rows = await callAi((ai) => ai.director.listMedia(aiCaller(userId, orgId)));
    return rows.map(toCut);
  }

  /**
   * Lines up a match cut between two of the caller's ready video takes of the short
   * (DIRECTOR_TAKE_NOT_FOUND otherwise): the AI service reads both through presigned
   * links and answers where to cut and how to move the incoming take.
   */
  async alignMatchCut(
    userId: UserId,
    orgId: OrgId,
    input: {
      videoId: VideoId;
      anchor: string;
      outgoing: { takeId: DirectorTakeId; atMs: number };
      incoming: { takeId: DirectorTakeId; atMs: number };
    },
  ): Promise<MatchCutAlignment> {
    const takes = await this.takes(userId, orgId, input.videoId);
    const read = async (side: { takeId: DirectorTakeId; atMs: number }) => {
      const take = takes.find((candidate) => candidate.id === side.takeId);
      if (take?.kind !== "video" || take.status !== "ready") {
        throw new AppError("DIRECTOR_TAKE_NOT_FOUND");
      }
      const { url } = await this.files.readUrl(
        userId,
        take.fileId,
        PURPOSE.video,
        TAKE_READ_EXPIRES_S,
      );
      return { url, atMs: side.atMs };
    };
    const [outgoing, incoming] = await Promise.all([read(input.outgoing), read(input.incoming)]);
    return matchCutAlignmentSchema.parse(
      await callAi((ai) =>
        ai.director.alignMatchCut(aiCaller(userId, orgId), {
          anchor: input.anchor,
          outgoing,
          incoming,
        }),
      ),
    );
  }

  /**
   * Saves a cut whose rendered video is a ready `director-cut-video` upload of the caller's,
   * and keeps the raw footage its takes were cut from for another week (a video saved is
   * what a member may want to recut).
   */
  async saveCut(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; picks: DirectorCut["picks"]; fileId: FileId; title: string },
  ): Promise<DirectorCut> {
    await this.files.ready(userId, input.fileId, "director-cut-video");
    // First, so a cut that's saved never answers with an error: footage kept a little
    // longer for a save that then fails costs nothing.
    await this.recording.keepFootageOf({ orgId, userId }, Object.values(input.picks));
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

  /**
   * The row as the contract serves it, with a short-lived link to its audio and, when
   * `media` is asked for, to a seeded template's storyboard cards, previews and music.
   */
  private async toPlan(row: unknown, { media }: { media: boolean }): Promise<DirectorPlan> {
    const { audioStatus, audioKey, assetImages, plan: stored, ...plan } = wirePlan.parse(row);
    const shotPlan =
      stored && plan.source === "seed" ? withSeedAssets(plan.videoId, stored) : stored;
    const [url, served] = await Promise.all([
      audioStatus === "ready" && audioKey
        ? this.files.objectUrl(audioKey, AUDIO_READ_EXPIRES_S)
        : null,
      shotPlan && media ? this.withMedia(plan, shotPlan, assetImages) : shotPlan,
    ]);
    return { ...plan, plan: served, audio: { status: audioStatus, url } };
  }

  /**
   * A plan with links to its media: a seed's storyboard cards, previews and music, and
   * any plan's asset images (a seed's committed with it, a member's as the AI service
   * reports them).
   */
  private async withMedia(
    plan: { id: string; videoId: VideoId; source: DirectorPlan["source"] },
    shotPlan: ShotPlan,
    rows: readonly AssetImageRow[],
  ): Promise<ServedShotPlan> {
    const seed = plan.source === "seed";
    const made = seed ? seedAssetImages(plan.videoId, shotPlan) : planAssetImages(plan.id, rows);
    // Only the plan's own assets' images are served, so only theirs are signed.
    const ids = new Set(shotPlan.assets.map((asset) => asset.id));
    const images = made.filter((image) => ids.has(image.assetId));
    const [served, signed] = await Promise.all([
      seed ? this.withSeedMedia(plan.videoId, shotPlan) : shotPlan,
      Promise.all(
        images.map(async (image) => ({
          image,
          url: image.key ? await this.files.objectUrl(image.key, MEDIA_READ_EXPIRES_S) : null,
        })),
      ),
    ]);
    return { ...served, assets: withAssetImages(served.assets, signed) };
  }

  /**
   * A seeded template's plan with links to its media: the committed seed's
   * (seedMediaKeys), never anything its stored plan names. Each link left out with
   * uploads off, like the audio's.
   */
  private async withSeedMedia(videoId: VideoId, shotPlan: ShotPlan): Promise<ServedShotPlan> {
    const signed = await Promise.all(
      seedMediaKeys(videoId, shotPlan.shots.length).map(async (media) => ({
        media,
        url: await this.files.objectUrl(media.key, MEDIA_READ_EXPIRES_S),
      })),
    );
    return withMediaLinks(shotPlan, signed);
  }
}
