/**
 * Publishing a member's cut to their YouTube channel as a Short.
 *
 * Gemini drafts the post in the AI service (`copy`); the member edits it; `upload` checks
 * what only this API can, in an order that keeps anything from reaching YouTube that
 * shouldn't: the shared demo account never publishes, the cut must be the caller's and
 * its video uploaded, checked and still in storage, and their Google account must allow
 * uploads to YouTube (the `youtube.upload` scope, asked for when they first publish).
 * Only then is the cut marked uploading and its video streamed from storage to YouTube
 * (youtube-upload.ts), with the member's own Google access token, which better-auth
 * refreshes when it has run out.
 */
import { Injectable } from "@nestjs/common";
import {
  type DirectorCut,
  type PublishCopy,
  type PublishVisibility,
  publishCopySchema,
  YOUTUBE_UPLOAD_SCOPE,
  youtubeDescription,
  youtubeTitle,
} from "@repo/contracts/api";
import type { DirectorCutId, OrgId, UserId } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { MINUTE_S } from "@repo/contracts/time";
import { AppError, isAppError } from "@repo/nest-common";
import * as z from "zod";
import { type Auth, InjectAuth } from "../../auth/auth.module";
import { env } from "../../env";
import { features } from "../../features";
import { aiCaller, callAi } from "../ai";
import { AnalyticsService } from "../analytics";
import { DirectorService } from "../director";
import { FilesService } from "../files";
import { ShortsService } from "../shorts";
import { DailyAllowance } from "./daily-allowance";
import { PublishRepository } from "./publish.repository";
import { uploadUrlOf, YouTubeUploadError, YouTubeUploader } from "./youtube-upload";

// Long enough to start streaming it; the read itself isn't bound by the link's expiry.
const VIDEO_READ_EXPIRES_S = 10 * MINUTE_S;

/** Who publishes: the procedure's caller, with whether they're the shared demo account. */
export interface Publisher {
  orgId: OrgId;
  userId: UserId;
  demo: boolean;
}

type Upload = PublishCopy & { cutId: DirectorCutId; visibility: PublishVisibility };

const videoLength = z.coerce.number().int().positive();

/** Whether a Google account's granted scopes (better-auth joins them with commas) allow uploads. */
export const allowsUploads = (scope: string | null) =>
  (scope ?? "").split(/[\s,]+/).includes(YOUTUBE_UPLOAD_SCOPE);

/** YouTube's reasons for refusing an upload over the project's quota or its rate. */
const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "uploadLimitExceeded",
  "rateLimitExceeded",
]);

/** What a failed upload means to the member: YouTube's refusal as a code, or the error. */
export function publishErrorOf(error: unknown): unknown {
  if (!(error instanceof YouTubeUploadError)) {
    return error;
  }
  if (error.reason === "youtubeSignupRequired") {
    return new AppError("PUBLISH_NO_CHANNEL", { cause: error });
  }
  if (QUOTA_REASONS.has(error.reason)) {
    return new AppError("PUBLISH_QUOTA_EXHAUSTED", { cause: error });
  }
  // The token was revoked, or the upload permission taken back since it was granted.
  if (error.status === 401 || error.reason === "insufficientPermissions") {
    return new AppError("PUBLISH_NEEDS_YOUTUBE", { cause: error });
  }
  return new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "youtube" }, cause: error });
}

@Injectable()
export class PublishService {
  private readonly youtube = new YouTubeUploader(uploadUrlOf(env.YOUTUBE_API_URL));

  constructor(
    @InjectAuth() private readonly auth: Auth,
    private readonly publishing: PublishRepository,
    private readonly director: DirectorService,
    private readonly files: FilesService,
    private readonly shorts: ShortsService,
    private readonly analytics: AnalyticsService,
    private readonly allowance: DailyAllowance,
  ) {}

  /** Gemini's draft of the post, knowing the original Short as YouTube shows it. */
  async copy(userId: UserId, orgId: OrgId, cutId: DirectorCutId): Promise<PublishCopy> {
    const cut = await this.director.cut(userId, orgId, cutId);
    const original = await this.shorts.credit(cut.videoId).catch((error: unknown) => {
      // Gemini can write the post without the original's title and channel: YouTube being
      // out of quota, or down, mustn't stop it.
      if (isAppError(error) && error.code === "UPSTREAM_UNAVAILABLE") {
        return null;
      }
      throw error;
    });
    const copy = await callAi((ai) =>
      ai.director.writePublishCopy(aiCaller(userId, orgId), { cutId, original }),
    );
    return publishCopySchema.parse(copy);
  }

  async upload(publisher: Publisher, input: Upload): Promise<DirectorCut> {
    const cut = await this.publishable(publisher, input.cutId);
    if (cut.publish.status === "published") {
      return cut;
    }
    const { orgId, userId } = publisher;
    const video = await this.video(userId, cut);
    const ready = await this.readyToSend(orgId, userId, cut).catch(async (error: unknown) => {
      await video.body.cancel();
      throw error;
    });
    if (!ready) {
      await video.body.cancel();
      return this.director.cut(userId, orgId, cut.id);
    }
    const uploaded = await this.youtube
      .upload(
        ready.accessToken,
        {
          title: youtubeTitle(input.title),
          description: youtubeDescription(input, cut.videoId),
          privacyStatus: input.visibility,
        },
        video,
      )
      .catch(async (error: unknown) => {
        // YouTube took no video: the day's place goes back with the cut's claim.
        await Promise.all([
          this.publishing.failed(orgId, cut.id),
          this.allowance.giveBack(ready.day),
        ]);
        throw publishErrorOf(error);
      });
    const published = { youtubeVideoId: uploaded.id, visibility: uploaded.status.privacyStatus };
    await this.publishing.published(orgId, cut.id, published);
    this.analytics.record("published", {
      userId,
      videoId: cut.videoId,
      detail: {
        youtubeVideoId: uploaded.id,
        asked: input.visibility,
        privacyStatus: published.visibility,
      },
    });
    return { ...cut, publish: { status: "published", ...published } };
  }

  /** The caller's cut, when the caller may publish at all. */
  private async publishable({ orgId, userId, demo }: Publisher, cutId: DirectorCutId) {
    if (demo) {
      throw new AppError("PUBLISH_DEMO_DISABLED");
    }
    if (!features.google) {
      throw new AppError("FEATURE_DISABLED", { params: { feature: "google" } });
    }
    return this.director.cut(userId, orgId, cutId);
  }

  /**
   * What sending the cut takes: the member's access token, one of the day's places
   * (PUBLISH_QUOTA_EXHAUSTED past them), and the cut claimed for this publish. Null when
   * another publish of it is under way, the place given back.
   */
  private async readyToSend(orgId: OrgId, userId: UserId, cut: DirectorCut) {
    const accessToken = await this.accessToken(userId);
    const day = await this.allowance.take();
    // Should this process die after YouTube took the video but before the cut is marked
    // published, the cut stays "uploading", and a publish after the stale window sends it
    // again: a second copy on the member's channel. Rare enough to accept; they can
    // delete one in YouTube Studio.
    if (!(await this.publishing.claim(orgId, userId, cut.id))) {
      await this.allowance.giveBack(day);
      return null;
    }
    return { accessToken, day };
  }

  /**
   * The cut's video, opened from storage as a stream (PUBLISH_CUT_NOT_READY unless its
   * upload is the caller's, checked, and still stored).
   */
  private async video(userId: UserId, cut: DirectorCut) {
    const { file, url } = await this.files
      .readUrl(userId, cut.fileId, "director-cut-video", VIDEO_READ_EXPIRES_S)
      .catch((error: unknown) => {
        if (isAppError(error) && ["FILE_NOT_FOUND", "FILE_NOT_READY"].includes(error.code)) {
          throw new AppError("PUBLISH_CUT_NOT_READY", { cause: error });
        }
        throw error;
      });
    const stored = await fetch(url);
    const size = videoLength.safeParse(stored.headers.get("content-length"));
    if (!stored.ok || !size.success) {
      // Storage's error, read to its end so the connection is released.
      await stored.text();
      throw new AppError("PUBLISH_CUT_NOT_READY");
    }
    return {
      body: required(stored.body, "a stored object's body"),
      size: size.data,
      contentType: required(file.contentType, "a checked upload's type"),
    };
  }

  /**
   * The member's Google access token, refreshed by better-auth when it has run out
   * (PUBLISH_NEEDS_YOUTUBE without a Google account allowed to upload, or when Google
   * won't refresh it any more: asking again fixes both).
   */
  private async accessToken(userId: UserId) {
    const account = await this.publishing.googleAccount(userId);
    if (!account || !allowsUploads(account.scope)) {
      throw new AppError("PUBLISH_NEEDS_YOUTUBE");
    }
    try {
      const { accessToken } = await this.auth.api.getAccessToken({
        body: { accountId: account.id, userId },
      });
      return accessToken;
    } catch (error) {
      throw new AppError("PUBLISH_NEEDS_YOUTUBE", { cause: error });
    }
  }
}
