/**
 * The asset picker (packages/contracts api/assets.ts), on top of the AI service, which
 * keeps each slot's images and choices and draws the member's images
 * (apps/ai/app/picker.py). This API checks what only it can: that an upload is the
 * caller's, checked and of the right kind (FilesService); the stock libraries, whose keys
 * stay here (stock/); copying a stock photo into storage; and the short-lived links to
 * every image, each signed only when its key is one the image may have.
 */
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type {
  AssetImage,
  AssetSlot,
  DirectorAssets,
  StockPhoto,
  StockProviderName,
} from "@repo/contracts/api";
import type { FileId, OrgId, UserId, VideoId } from "@repo/contracts/ids";
import { HOUR_S } from "@repo/contracts/time";
import * as z from "zod";
import { env } from "../../env";
import { aiCaller, callAi } from "../ai";
import { DirectorService } from "../director";
import { FilesService } from "../files";
import { createStockProviders } from "./stock/providers";
import { type Orientation, StockLibrary } from "./stock/stock";

// A slot's images are shown while the member picks; the list is read again before then.
const IMAGE_READ_EXPIRES_S = HOUR_S;
const PURPOSE = "director-asset-image";

const wireCredit = z.object({
  provider: z.enum(["pexels", "pixabay"]),
  author: z.string(),
  authorUrl: z.url(),
  pageUrl: z.url(),
});
const wireCandidate = z.object({
  id: z.uuid(),
  assetId: z.string(),
  origin: z.enum(["default", "created", "upload", "stock"]),
  status: z.enum(["pending", "generating", "ready", "failed"]),
  objectKey: z.string().nullable(),
  fileId: z.uuid().nullable(),
  error: z.string().nullable(),
  prompt: z.string().nullable(),
  credit: wireCredit.nullable(),
  createdAt: z.coerce.date(),
});
type WireCandidate = z.infer<typeof wireCandidate>;
const wireSlots = z.object({
  slots: z.array(
    z.object({
      assetId: z.string(),
      prompt: z.string(),
      candidates: z.array(wireCandidate),
      chosenId: z.uuid().nullable(),
      history: z.array(z.uuid().nullable()),
    }),
  ),
  imagesUsed: z.number().int(),
  imagesPerVideo: z.number().int(),
  imagesToday: z.number().int(),
  imagesPerDay: z.number().int(),
});

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The only key an image may be stored at: a drawn or stock one in its slot's folder of
 * the plan's, named by its own id; an upload at its file's. Anything else the AI service
 * answers is served as failed, never signed.
 */
export function imageKeyAllowed(planId: string, image: WireCandidate): boolean {
  const key = image.objectKey;
  if (key === null) {
    return false;
  }
  if (image.origin === "upload") {
    return image.fileId !== null && key === `files/${image.fileId}`;
  }
  const slotFolder = `director-assets/${planId}/${image.assetId}/`;
  return (
    key.startsWith(slotFolder) &&
    new RegExp(`^${UUID}\\.(png|jpg|mp4)$`).test(key.slice(slotFolder.length))
  );
}

const STATUS: Record<WireCandidate["status"], AssetImage["status"]> = {
  pending: "making",
  generating: "making",
  ready: "ready",
  failed: "failed",
};

@Injectable()
export class AssetsService {
  private readonly stock = new StockLibrary(createStockProviders(env));

  constructor(
    private readonly director: DirectorService,
    private readonly files: FilesService,
  ) {}

  async list(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<DirectorAssets> {
    const [plan, row] = await Promise.all([
      this.director.plan(userId, orgId, videoId),
      callAi((ai) => ai.director.listAssets(aiCaller(userId, orgId), videoId)),
    ]);
    const wire = wireSlots.parse(row);
    const served = plan.plan?.assets ?? [];
    const slots = await Promise.all(
      wire.slots.map(async (slot): Promise<AssetSlot> => {
        const image = served.find((asset) => asset.id === slot.assetId)?.image;
        const defaultRow = slot.candidates.find((candidate) => candidate.origin === "default");
        const own = slot.candidates.filter((candidate) => candidate.origin !== "default");
        return {
          assetId: slot.assetId,
          prompt: slot.prompt,
          defaultImage: image ? { id: defaultRow?.id ?? null, ...image } : null,
          images: await Promise.all(own.map((candidate) => this.served(plan.id, candidate))),
          chosenId: slot.chosenId,
          history: slot.history,
        };
      }),
    );
    return {
      slots,
      images: {
        used: wire.imagesUsed,
        perVideo: wire.imagesPerVideo,
        today: wire.imagesToday,
        perDay: wire.imagesPerDay,
      },
    };
  }

  /** Queues an image drawn from the caller's prompt (and their checked upload). */
  async draw(
    userId: UserId,
    orgId: OrgId,
    demo: boolean,
    input: {
      videoId: VideoId;
      assetId: string;
      prompt: string;
      instruction?: string | undefined;
      baseId?: string | undefined;
      referenceFileId?: FileId | undefined;
      clip?: boolean | undefined;
    },
  ): Promise<AssetImage> {
    if (input.referenceFileId) {
      await this.files.ready(userId, input.referenceFileId, PURPOSE);
    }
    const plan = await this.director.planOf(userId, orgId, input.videoId);
    const row = await callAi((ai) =>
      ai.director.drawAsset(aiCaller(userId, orgId), input, {
        prompt: input.prompt,
        instruction: input.instruction ?? null,
        baseId: input.baseId ?? null,
        referenceKey: input.referenceFileId ? `files/${input.referenceFileId}` : null,
        demo,
        clip: input.clip ?? false,
      }),
    );
    return this.served(plan.id, wireCandidate.parse(row));
  }

  /** Adds the caller's checked upload to the slot. */
  async addUpload(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; assetId: string; fileId: FileId },
  ): Promise<AssetImage> {
    await this.files.ready(userId, input.fileId, PURPOSE);
    const plan = await this.director.planOf(userId, orgId, input.videoId);
    const row = await callAi((ai) =>
      ai.director.addAsset(aiCaller(userId, orgId), input, {
        origin: "upload",
        objectKey: `files/${input.fileId}`,
        fileId: input.fileId,
        credit: null,
      }),
    );
    return this.served(plan.id, wireCandidate.parse(row));
  }

  /** Copies a stock photo into the slot's folder in storage, with its credit. */
  async addStock(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; assetId: string; provider: StockProviderName; photoId: string },
  ): Promise<AssetImage> {
    const plan = await this.director.planOf(userId, orgId, input.videoId);
    const copy = await this.stock.copy(input.provider, input.photoId);
    const key = `director-assets/${plan.id}/${input.assetId}/${randomUUID()}.${copy.extension}`;
    await this.files.writeObject(key, copy.data, copy.contentType);
    const row = await callAi((ai) =>
      ai.director.addAsset(aiCaller(userId, orgId), input, {
        origin: "stock",
        objectKey: key,
        fileId: null,
        credit: copy.credit,
      }),
    );
    return this.served(plan.id, wireCandidate.parse(row));
  }

  async choose(
    userId: UserId,
    orgId: OrgId,
    input: { videoId: VideoId; assetId: string; imageId: string | null },
  ): Promise<{ ok: true }> {
    await callAi((ai) =>
      ai.director.chooseAsset(aiCaller(userId, orgId), input, { candidateId: input.imageId }),
    );
    return { ok: true };
  }

  /**
   * Whether the caller's video of `videoId` uses AI footage: a Veo clip chosen for a gap,
   * which YouTube asks to be declared as altered or synthetic content.
   */
  async usesSyntheticMedia(userId: UserId, orgId: OrgId, videoId: VideoId): Promise<boolean> {
    const assets = await this.list(userId, orgId, videoId);
    return assets.slots.some((slot) =>
      slot.images.some(
        (image) =>
          image.id === slot.chosenId && image.origin === "created" && image.media === "video",
      ),
    );
  }

  searchStock(input: { query: string; orientation: Orientation }): Promise<StockPhoto[]> {
    return this.stock.search(input.query, input.orientation);
  }

  /** An image as served: its status, and a short-lived link once it's ready. */
  private async served(planId: string, image: WireCandidate): Promise<AssetImage> {
    const allowed = image.status === "ready" && imageKeyAllowed(planId, image);
    const status = image.status === "ready" && !allowed ? "failed" : STATUS[image.status];
    return {
      id: image.id,
      origin: image.origin === "default" ? "created" : image.origin,
      media: image.objectKey?.endsWith(".mp4") ? "video" : "image",
      status,
      url:
        allowed && image.objectKey
          ? await this.files.objectUrl(image.objectKey, IMAGE_READ_EXPIRES_S)
          : null,
      prompt: image.prompt,
      credit: image.credit,
      error: image.error,
      createdAt: image.createdAt,
    };
  }
}
