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
import { Inject, Injectable } from "@nestjs/common";
import {
  type BrainstormReply,
  type BriefInput,
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
  type ServedShotPlan,
  type ShotPlan,
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
import { TAKE_REVIEW_READ_S } from "@repo/jobs";
import {
  AppError,
  createRateLimiter,
  describeError,
  InjectPinoLogger,
  isAppError,
  PinoLogger,
  type RateLimiter,
  REDIS,
  type Redis,
} from "@repo/nest-common";
import * as z from "zod";
import { visitorLimitKey } from "../../auth/demo";
import { env } from "../../env";
import { aiCaller, callAi } from "../ai";
import { AnalyticsService } from "../analytics";
import { FilesService } from "../files";
import {
  type ChatLedger,
  type ChatSpend,
  chatUpstream,
  createGoogleAuth,
  DirectorChat,
} from "../live";
import { RecordingService } from "../recording";
import { ShortsService } from "../shorts";
import {
  type AssetImageRow,
  planAssetImages,
  storyboardKeyAllowed,
  withAssetImages,
} from "./asset-images";
import { chatTurnDetail } from "./chat-turn";
import { seedAssetImages, seedMediaKeys, withMediaLinks, withSeedAssets } from "./seed-media";
import { shotsOf } from "./shots";
import { storyboardState } from "./storyboards";

// The review job reads the take with it, maybe behind a backlog and after minutes of
// retries (packages/jobs says how long that can take).
const TAKE_READ_EXPIRES_S = TAKE_REVIEW_READ_S;
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
// A brief's photos are read by a brainstorm turn at once, and by the job that writes the
// plan within its retries (three, minutes apart).
const BRIEF_PHOTO_READ_EXPIRES_S = 30 * MINUTE_S;

const PURPOSE: Record<DirectorTake["kind"], UploadPurpose> = {
  video: "director-take-video",
  photo: "director-take-photo",
};
// What the worker stores a take as (apps/worker files processor).
const takeContentType = z.enum(["video/webm", "video/mp4", "image/jpeg"]);
const takeVideoType = z.enum(["video/webm", "video/mp4"]);

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
  // A created plan's storyboard cards, by shot; none for any other plan. An AI service
  // from before card errors reports none.
  storyboards: z
    .array(
      z.object({
        shotIndex: z.number().int(),
        status: z.enum(["pending", "generating", "ready", "failed"]),
        objectKey: z.string().nullable(),
        error: z.string().nullable().default(null),
      }),
    )
    .default([]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
type StoryboardRow = z.infer<typeof wirePlan>["storyboards"][number];
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
  /**
   * Links to index that aren't in the library yet, each a YouTube lookup: ten an hour a
   * member. Kept here rather than in the contract, which would count opening a template
   * already in the library too (director.index's meta says so).
   */
  private readonly indexLinks: RateLimiter;

  constructor(
    private readonly shorts: ShortsService,
    private readonly files: FilesService,
    private readonly recording: RecordingService,
    private readonly analytics: AnalyticsService,
    @InjectPinoLogger(DirectorService.name) private readonly log: PinoLogger,
    @Inject(REDIS) redis: Redis,
  ) {
    this.indexLinks = createRateLimiter(redis, {
      name: "director-index",
      points: 10,
      windowSeconds: HOUR_S,
      onRedisError: "deny",
    });
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

  /**
   * Indexes the short a link points at, once it's known to be one Director can film. A
   * short already in the library is only opened: free, and not asked of YouTube. Anything
   * else spends the member's index allowance first (per visitor on the shared demo).
   */
  async index(
    caller: { userId: UserId; orgId: OrgId; sharedDemo: boolean },
    url: string,
  ): Promise<DirectorPlan> {
    const { userId, orgId } = caller;
    const linked = this.shorts.videoIdOf(url);
    const opened = linked ? await this.inLibrary(userId, orgId, linked) : null;
    if (opened) {
      return opened;
    }
    await this.indexLinks.take(visitorLimitKey(userId, caller.sharedDemo));
    const { videoId } = await this.shorts.filmable(url);
    const row = await callAi((ai) => ai.director.index(aiCaller(userId, orgId), videoId));
    return this.toPlan(row, { media: false });
  }

  /**
   * The workspace's plan of the short, when it has one to open; null otherwise, and for
   * one that failed, which indexing it again tries again.
   */
  private async inLibrary(
    userId: UserId,
    orgId: OrgId,
    videoId: VideoId,
  ): Promise<DirectorPlan | null> {
    try {
      const plan = await this.toPlan(await this.planRow(userId, orgId, videoId), { media: false });
      return plan.status === "failed" ? null : plan;
    } catch (error) {
      if (isAppError(error) && error.code === "DIRECTOR_PLAN_NOT_FOUND") {
        return null;
      }
      throw error;
    }
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
    const asked = performance.now();
    const reply = await this.chatLine.reply(plan.plan, input, this.chatLedger(userId, orgId));
    this.analytics.record("director_turn", {
      userId,
      videoId: input.videoId,
      templateId: plan.plan.format,
      detail: chatTurnDetail(input, reply, performance.now() - asked),
    });
    return reply;
  }

  /**
   * Where the slower line's turns are counted: the AI service's ledger, the workspace's
   * monthly allowance every other call of Director's spends (AI_BUDGET_EXCEEDED when it's
   * gone). A turn is reserved before it asks Gemini and settled with what Gemini said it
   * cost, however it ends.
   */
  private chatLedger(userId: UserId, orgId: OrgId): ChatLedger {
    const caller = aiCaller(userId, orgId);
    const model = env.CHAT_MODEL;
    return {
      charge: async (turn) => {
        const { tokens } = await callAi((ai) => ai.director.reserveChatTurn(caller, { model }));
        const spent: ChatSpend = { inputTokens: 0, outputTokens: 0, counted: true };
        try {
          return await turn(spent);
        } finally {
          await this.settleChatTurn(caller, model, tokens, spent);
        }
      },
    };
  }

  private async settleChatTurn(
    caller: ReturnType<typeof aiCaller>,
    model: string,
    reserved: number,
    spent: ChatSpend,
  ) {
    // An answer that didn't say what it cost keeps the whole reservation.
    const inputTokens = spent.counted ? spent.inputTokens : Math.max(reserved, spent.inputTokens);
    try {
      await callAi((ai) =>
        ai.director.settleChatTurn(caller, {
          model,
          reserved,
          inputTokens,
          outputTokens: spent.outputTokens,
        }),
      );
    } catch (error) {
      // The reservation stands, which errs on the allowance's side; the member's reply
      // doesn't wait on the ledger.
      this.log.warn({ err: describeError(error) }, "settling a slower line turn failed");
    }
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

  /**
   * The member's choice of take for a shot, over Director's pick (or none, to go back to
   * it); answers with every shot as it is now.
   */
  async chooseTake(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; shotIndex: number; takeId: DirectorTakeId | null },
  ): Promise<DirectorShot[]> {
    await callAi((ai) =>
      ai.director.chooseTake(aiCaller(userId, orgId), input.videoId, {
        shotIndex: input.shotIndex,
        takeId: input.takeId,
      }),
    );
    return this.shots(userId, orgId, input.videoId);
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
      const { file, url } = await this.files.readUrl(
        userId,
        take.fileId,
        PURPOSE.video,
        TAKE_READ_EXPIRES_S,
      );
      // The AI service reads it as this type and no other (a ready video take's always one).
      const contentType = takeVideoType.safeParse(file.contentType);
      if (!contentType.success) {
        throw new AppError("DIRECTOR_TAKE_NOT_FOUND");
      }
      return { url, atMs: side.atMs, contentType: contentType.data };
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
    input: {
      videoId: VideoId;
      picks: DirectorCut["picks"];
      fileId: FileId;
      title: string;
      durationMs?: number | undefined;
    },
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
        durationMs: input.durationMs,
        picks: Object.entries(input.picks).map(([shotIndex, takeId]) => ({
          shotIndex: Number(shotIndex),
          takeId,
        })),
      }),
    );
    return toCut(row);
  }

  /**
   * Director's next turn while the member describes a template: their photos (ready
   * `director-brief-photo` uploads of theirs) go to the AI service as short-lived reads.
   */
  async brainstorm(userId: UserId, orgId: OrgId, input: BriefInput): Promise<BrainstormReply> {
    const photos = await this.briefPhotos(userId, input.photos);
    return callAi((ai) =>
      ai.director.brainstorm(aiCaller(userId, orgId), {
        text: input.text,
        messages: input.messages,
        photos,
      }),
    );
  }

  /** A template of the member's own, queued to be written from their brief and photos. */
  async create(userId: UserId, orgId: OrgId, input: BriefInput): Promise<DirectorPlan> {
    const photos = await this.briefPhotos(userId, input.photos);
    const row = await callAi((ai) =>
      ai.director.createTemplate(aiCaller(userId, orgId), {
        text: input.text,
        messages: input.messages,
        photos,
      }),
    );
    return this.toPlan(row, { media: false });
  }

  /** The member's changes to the shots of a template they described. */
  async editPlan(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; plan: ShotPlan },
  ): Promise<DirectorPlan> {
    const row = await callAi((ai) => ai.director.editTemplate(aiCaller(userId, orgId), input));
    return this.toPlan(row, { media: true });
  }

  private briefPhotos(userId: UserId, photos: readonly FileId[]) {
    return Promise.all(
      photos.map(async (fileId) => {
        const { url } = await this.files.readUrl(
          userId,
          fileId,
          "director-brief-photo",
          BRIEF_PHOTO_READ_EXPIRES_S,
        );
        return { fileId, url };
      }),
    );
  }

  /**
   * The row as the contract serves it, with a short-lived link to its audio and, when
   * `media` is asked for, to a seeded template's storyboard cards, previews and music.
   */
  private async toPlan(row: unknown, { media }: { media: boolean }): Promise<DirectorPlan> {
    const {
      audioStatus,
      audioKey,
      assetImages,
      storyboards,
      plan: stored,
      ...plan
    } = wirePlan.parse(row);
    const shotPlan =
      stored && plan.source === "seed" ? withSeedAssets(plan.videoId, stored) : stored;
    const [url, served] = await Promise.all([
      audioStatus === "ready" && audioKey
        ? this.files.objectUrl(audioKey, AUDIO_READ_EXPIRES_S)
        : null,
      shotPlan && media ? this.withMedia(plan, shotPlan, assetImages, storyboards) : shotPlan,
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
    storyboards: readonly StoryboardRow[] = [],
  ): Promise<ServedShotPlan> {
    const seed = plan.source === "seed";
    const made = seed ? seedAssetImages(plan.videoId, shotPlan) : planAssetImages(plan.id, rows);
    // Only the plan's own assets' images are served, so only theirs are signed.
    const ids = new Set(shotPlan.assets.map((asset) => asset.id));
    const images = made.filter((image) => ids.has(image.assetId));
    const [served, signed] = await Promise.all([
      seed
        ? this.withSeedMedia(plan.videoId, shotPlan)
        : this.withStoryboards(plan.id, shotPlan, storyboards),
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
   * A created plan with a link to each shot's storyboard card that's drawn, signed only
   * where a card of the plan's own may be stored, and the state of each that isn't
   * (still drawing, or why it isn't coming).
   */
  private async withStoryboards(
    planId: string,
    shotPlan: ShotPlan,
    storyboards: readonly StoryboardRow[],
  ): Promise<ServedShotPlan> {
    const links = new Map<number, string>();
    await Promise.all(
      storyboards.map(async ({ shotIndex, status, objectKey }) => {
        const url =
          status === "ready" && objectKey && storyboardKeyAllowed(planId, objectKey)
            ? await this.files.objectUrl(objectKey, MEDIA_READ_EXPIRES_S)
            : null;
        if (url) {
          links.set(shotIndex, url);
        }
      }),
    );
    const states = new Map(storyboards.map((card) => [card.shotIndex, storyboardState(card)]));
    return {
      ...shotPlan,
      shots: shotPlan.shots.map((shot, index) => {
        const storyboardUrl = links.get(index);
        if (storyboardUrl) {
          return { ...shot, storyboardUrl };
        }
        const storyboardState = states.get(index);
        return storyboardState ? { ...shot, storyboardState } : shot;
      }),
    };
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
