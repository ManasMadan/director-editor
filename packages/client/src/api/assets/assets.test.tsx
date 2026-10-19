import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssetImage, DirectorAssets, FileInfo, StockPhoto } from "@repo/contracts/api";
import { fileIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { useAddStockAssetMutation } from "./add-stock";
import { useChooseAssetMutation } from "./choose";
import { useDrawAssetMutation } from "./draw";
import { useAssetSlotsQuery } from "./slots";
import { useStockSearchQuery } from "./stock-search";
import { useUploadAssetMutation } from "./upload";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");
const assetId = "chart";

const image = (status: AssetImage["status"]): AssetImage => ({
  id: id(2),
  origin: "created",
  media: "image",
  status,
  url: status === "ready" ? "https://files.test/chart.png" : null,
  prompt: "A bar chart of coffee by hour",
  credit: null,
  error: null,
  createdAt: new Date(0),
});

const slots = (
  images: AssetImage[],
  defaultStatus: AssetImage["status"] | null = "ready",
): DirectorAssets => ({
  slots: [
    {
      assetId,
      prompt: "A bar chart",
      defaultImage: defaultStatus && { id: null, status: defaultStatus, url: null },
      images,
      chosenId: null,
      history: [],
    },
  ],
  images: { used: images.length, perVideo: 12, today: images.length, perDay: 30 },
});

const readyFile = (purpose: FileInfo["purpose"]): FileInfo => ({
  id: fileIdSchema.parse(id(9)),
  purpose,
  status: "ready",
  filename: "me.png",
  contentType: "image/png",
  size: 5,
  rejectReason: null,
  createdAt: new Date(0),
});

// Object storage, as a presigned PUT sees it: takes the bytes.
let storage: Server;
let storageUrl: string;
const stored: string[] = [];
beforeAll(async () => {
  storage = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    stored.push(body);
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}/uploads/${id(9)}`;
});
afterAll(() => new Promise<void>((resolve) => storage.close(() => resolve())));
afterEach(() => {
  stored.length = 0;
  vi.useRealTimers();
});

describe("a short's asset slots", () => {
  it("are polled while an image is being drawn, and left alone once every one is done", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers = [slots([image("making")]), slots([], "making"), slots([image("ready")])];
    let asked = 0;
    const api = standIn((os) => ({
      assets: {
        list: os.assets.list.handler(({ input }) => {
          expect(input).toEqual({ videoId });
          return answers[Math.min(asked++, answers.length - 1)] ?? slots([]);
        }),
      },
    }));
    const { result } = renderHook(() => useAssetSlotsQuery(videoId), api);
    await until(() => expect(result.current.data?.slots[0]?.images[0]?.status).toBe("making"));
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS);
    await until(() => expect(result.current.data?.slots[0]?.defaultImage?.status).toBe("making"));
    await vi.advanceTimersByTimeAsync(5 * SECOND_MS);
    await until(() => expect(result.current.data?.slots[0]?.images[0]?.status).toBe("ready"));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(asked).toBe(3);
  });

  it("aren't polled for a slot with no default image and nothing being drawn", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = standIn((os) => ({
      assets: { list: os.assets.list.handler(() => slots([], null)) },
    }));
    const { result } = renderHook(() => useAssetSlotsQuery(videoId), api);
    await until(() => expect(result.current.data?.slots[0]?.defaultImage).toBeNull());
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(api.calls).toEqual(["assets/list"]);
  });
});

describe("changing a slot", () => {
  /** The slots, and every change to them: each answers the image it was asked for. */
  const slotsApi = (seen: unknown[]) =>
    standIn((os) => ({
      assets: {
        list: os.assets.list.handler(() => slots([])),
        draw: os.assets.draw.handler(({ input }) => {
          seen.push(input);
          return image("making");
        }),
        addUpload: os.assets.addUpload.handler(({ input }) => {
          seen.push(input);
          return { ...image("ready"), origin: "upload" as const };
        }),
        addStock: os.assets.addStock.handler(({ input }) => {
          seen.push(input);
          return { ...image("ready"), origin: "stock" as const };
        }),
        choose: os.assets.choose.handler(({ input }) => {
          seen.push(input);
          return { ok: true as const };
        }),
      },
      files: {
        createUpload: os.files.createUpload.handler(({ input }) => ({
          file: { ...readyFile(input.purpose), status: "pending" as const },
          upload: {
            url: storageUrl,
            headers: { "Content-Type": input.contentType, "Content-Length": String(input.size) },
            expiresAt: new Date(Date.now() + MINUTE_MS),
          },
        })),
        completeUpload: os.files.completeUpload.handler(() => readyFile("director-asset-image")),
      },
    }));
  const picture = () => new File(["hello"], "me.png", { type: "image/png" });
  const listed = (calls: string[]) => calls.filter((call) => call === "assets/list").length;

  it("draws an image from a prompt, and reads the slots again", async () => {
    const seen: unknown[] = [];
    const api = slotsApi(seen);
    const { result } = renderHook(
      () => ({ slots: useAssetSlotsQuery(videoId), draw: useDrawAssetMutation() }),
      api,
    );
    await until(() => expect(result.current.slots.data).toBeDefined());
    await result.current.draw.mutateAsync({ videoId, assetId, prompt: "A bar chart" });
    expect(seen).toEqual([{ videoId, assetId, prompt: "A bar chart" }]);
    await until(() => expect(listed(api.calls)).toBe(2));
    expect(api.calls).not.toContain("files/createUpload");
  });

  it("uploads the member's photo first when a drawing starts from one", async () => {
    const seen: unknown[] = [];
    const api = slotsApi(seen);
    const { result } = renderHook(() => useDrawAssetMutation(), api);
    await result.current.mutateAsync({
      videoId,
      assetId,
      prompt: "Me holding the chart",
      reference: picture(),
    });
    expect(stored).toEqual(["hello"]);
    expect(seen).toEqual([
      { videoId, assetId, prompt: "Me holding the chart", referenceFileId: id(9) },
    ]);
    expect(api.calls).toEqual(["files/createUpload", "files/completeUpload", "assets/draw"]);
  });

  it("puts the member's upload in the slot once the worker has passed it", async () => {
    const seen: unknown[] = [];
    const api = slotsApi(seen);
    const { result } = renderHook(
      () => ({ slots: useAssetSlotsQuery(videoId), upload: useUploadAssetMutation() }),
      api,
    );
    await until(() => expect(result.current.slots.data).toBeDefined());
    await expect(
      result.current.upload.mutateAsync({ videoId, assetId, file: picture() }),
    ).resolves.toMatchObject({ origin: "upload" });
    expect(seen).toEqual([{ videoId, assetId, fileId: id(9) }]);
    await until(() => expect(listed(api.calls)).toBe(2));
  });

  it("puts a stock photo in the slot", async () => {
    const seen: unknown[] = [];
    const api = slotsApi(seen);
    const { result } = renderHook(
      () => ({ slots: useAssetSlotsQuery(videoId), stock: useAddStockAssetMutation() }),
      api,
    );
    await until(() => expect(result.current.slots.data).toBeDefined());
    const input = { videoId, assetId, provider: "pexels" as const, photoId: "123" };
    await expect(result.current.stock.mutateAsync(input)).resolves.toMatchObject({
      origin: "stock",
    });
    expect(seen).toEqual([input]);
    await until(() => expect(listed(api.calls)).toBe(2));
  });

  it("chooses the image the video uses, or goes back to the default", async () => {
    const seen: unknown[] = [];
    const api = slotsApi(seen);
    const { result } = renderHook(
      () => ({ slots: useAssetSlotsQuery(videoId), choose: useChooseAssetMutation() }),
      api,
    );
    await until(() => expect(result.current.slots.data).toBeDefined());
    await result.current.choose.mutateAsync({ videoId, assetId, imageId: id(2) });
    await result.current.choose.mutateAsync({ videoId, assetId, imageId: null });
    expect(seen).toEqual([
      { videoId, assetId, imageId: id(2) },
      { videoId, assetId, imageId: null },
    ]);
    await until(() => expect(listed(api.calls)).toBe(3));
  });
});

describe("searching stock photos", () => {
  const photo: StockPhoto = {
    provider: "pixabay",
    id: "42",
    previewUrl: "https://cdn.pixabay.test/42.jpg",
    width: 640,
    height: 960,
    alt: "Coffee",
    author: "Ana",
    authorUrl: "https://pixabay.test/users/ana",
    pageUrl: "https://pixabay.test/photos/42",
  };

  it("asks only once there are words, without the spaces around them", async () => {
    const asked: unknown[] = [];
    const api = standIn((os) => ({
      assets: {
        searchStock: os.assets.searchStock.handler(({ input }) => {
          asked.push(input);
          return [photo];
        }),
      },
    }));
    let query = "   ";
    const { result, rerender } = renderHook(() => useStockSearchQuery(query, "portrait"), api);
    expect(result.current.fetchStatus).toBe("idle");
    query = "  coffee  ";
    rerender();
    await until(() => expect(result.current.data).toEqual([photo]));
    expect(asked).toEqual([{ query: "coffee", orientation: "portrait" }]);
  });
});
