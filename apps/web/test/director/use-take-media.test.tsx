import type { DirectorTake } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { type MediaState, useTakeMedia } from "@/modules/director/hooks/use-take-media";
import type { Clip } from "@/modules/director/lib/edit";
import { soundPeaks, videoFrames } from "@/modules/director/lib/thumbnails";
import { deferred, id, renderHook, shot, standIn } from "./support";

// Decoding a take's frames and sound is the browser's work, tested with lib/thumbnails.
vi.mock("@/modules/director/lib/thumbnails", () => ({
  videoFrames: vi.fn(async (url: string, times: number[]) =>
    times.map((seconds) => ({ seconds, src: `${url}#t=${seconds}` })),
  ),
  soundPeaks: vi.fn(async () => [0.5, 1]),
}));

beforeEach(() => {
  vi.mocked(videoFrames).mockClear();
  vi.mocked(soundPeaks).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const take = (n: number, kind: DirectorTake["kind"] = "video"): DirectorTake => ({
  id: directorTakeIdSchema.parse(id(n)),
  shotIndex: 0,
  fileId: fileIdSchema.parse(id(100 + n)),
  kind,
  status: "ready",
  error: null,
  bestStartMs: null,
  bestEndMs: null,
  score: 80,
  feedback: null,
  createdAt: new Date(0),
});

const clip = (index: number, overrides: Partial<Clip> = {}): Clip => ({
  index,
  shot: shot(),
  take: take(index),
  state: "cut",
  at: 0,
  seconds: 2,
  from: 1,
  to: 3,
  ...overrides,
});

/** Storage, as the API's download URLs point at it: each file's bytes by file id. */
function storage(answer?: (fileId: string) => Promise<string> | string) {
  const api = standIn((os) => ({
    files: {
      downloadUrl: os.files.downloadUrl.handler(async ({ input }) => ({
        url: answer
          ? await answer(input.fileId)
          : URL.createObjectURL(new Blob([`bytes of ${input.fileId}`])),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    },
  }));
  return api;
}

const loaded = (state: MediaState | undefined) => {
  if (typeof state !== "object") {
    throw new Error(`not loaded: ${state}`);
  }
  return state;
};

describe("useTakeMedia", () => {
  it("downloads each filmed take once, with frames and sound along the kept part", async () => {
    const api = storage();
    let clips = [
      clip(0),
      clip(1, { shot: shot({ kind: "photo" }), take: take(1, "photo"), seconds: 1 }),
      clip(2, { state: "missing", take: null }),
      clip(3, { state: "reviewing" }),
    ];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect.poll(() => typeof hook.current.get(0)).toBe("object");

    const video = loaded(hook.current.get(0));
    expect(await video.blob.text()).toBe(`bytes of ${id(100)}`);
    expect(await (await fetch(video.url)).text()).toBe(`bytes of ${id(100)}`);
    // 2 seconds at 64px a second: four 36px frames, 32 bars of 4px.
    expect(videoFrames).toHaveBeenCalledWith(video.url, [1.25, 1.75, 2.25, 2.75]);
    expect(soundPeaks).toHaveBeenCalledWith(video.blob, 1, 3, 32);
    expect(video.thumbnails).toHaveLength(4);
    expect(video.peaks).toEqual([0.5, 1]);

    await expect.poll(() => typeof hook.current.get(1)).toBe("object");
    const photo = loaded(hook.current.get(1));
    expect(photo.thumbnails).toEqual([{ seconds: 0, src: photo.url }]);
    expect(photo.peaks).toBeNull();
    expect([...hook.current.keys()].sort()).toEqual([0, 1]);

    // The same takes again, and one more: only the new one is downloaded.
    clips = [...clips.map((each) => ({ ...each })), clip(4)];
    hook.rerender();
    await expect.poll(() => typeof hook.current.get(4)).toBe("object");
    expect(api.calls).toHaveLength(3);
  });

  it("frames a short take at least once", async () => {
    const api = storage();
    const clips = [clip(0, { seconds: 0.25, from: 0, to: 0.25 })];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect.poll(() => typeof hook.current.get(0)).toBe("object");
    expect(videoFrames).toHaveBeenCalledWith(expect.any(String), [0.125]);
    expect(soundPeaks).toHaveBeenCalledWith(expect.any(Blob), 0, 0.25, 4);
  });

  it("loads afresh when another part is kept, and drops what the old one finds", async () => {
    const first = deferred<string>();
    const api = storage((fileId) =>
      api.calls.length === 1 ? first.promise : URL.createObjectURL(new Blob([`new ${fileId}`])),
    );
    let clips = [clip(0)];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect.poll(() => api.calls).toHaveLength(1);
    await expect.poll(() => hook.current.get(0)).toBe("loading");

    clips = [clip(0, { from: 0.5, to: 2.5 })];
    hook.rerender();
    await expect.poll(() => typeof hook.current.get(0)).toBe("object");
    first.resolve(URL.createObjectURL(new Blob(["old"])));
    await expect.poll(() => videoFrames).toHaveBeenCalledTimes(2);
    expect(await loaded(hook.current.get(0)).blob.text()).toBe(`new ${id(100)}`);
  });

  it("marks a take that couldn't be downloaded", async () => {
    await commands.failRequests("/takes/missing", { status: 404 });
    const api = standIn((os) => ({
      files: {
        downloadUrl: os.files.downloadUrl.handler(({ input, errors }) => {
          if (input.fileId === id(100)) {
            throw errors.FILE_NOT_FOUND({ data: { params: {} } });
          }
          return {
            url: `${window.location.origin}/takes/missing`,
            expiresAt: new Date(Date.now() + 60_000),
          };
        }),
      },
    }));
    const clips = [clip(0), clip(1)];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect
      .poll(() => [hook.current.get(0), hook.current.get(1)])
      .toEqual(["failed", "failed"]);
    expect(await commands.failedRequests("/takes/missing")).toBe(1);
  });

  it("revokes the takes' URLs when the page goes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const clips = [clip(0), clip(1)];
    const hook = await renderHook(() => useTakeMedia(clips), { api: storage() });
    await expect.poll(() => hook.current.size).toBe(2);
    await expect
      .poll(() => [...hook.current.values()].every((state) => typeof state === "object"))
      .toBe(true);
    const urls = [...hook.current.values()].map((state) => loaded(state).url);
    hook.unmount();
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(urls.sort());
  });
});
