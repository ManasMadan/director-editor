import type { DirectorTake } from "@repo/contracts/api";
import { directorTakeIdSchema, fileIdSchema } from "@repo/contracts/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { type MediaState, useTakeMedia } from "@/modules/director/hooks/use-take-media";
import type { Clip } from "@/modules/director/lib/edit";
import { videoFrames } from "@/modules/director/lib/thumbnails";
import { id, renderHook, shot, standIn } from "./support";

// Decoding a take's frames is the browser's work, tested with lib/thumbnails. A spy (not
// a factory) keeps the real module loaded, so its coverage from those tests isn't zeroed
// when the reports merge.
vi.mock("@/modules/director/lib/thumbnails", { spy: true });

beforeEach(() => {
  vi.mocked(videoFrames)
    .mockClear()
    .mockImplementation(async (url, times) =>
      times.map((seconds) => ({ seconds, src: `${url}#t=${seconds}` })),
    );
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
  reason: null,
  chosen: false,
  origin: "shoot",
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
function storage() {
  return standIn((os) => ({
    files: {
      downloadUrl: os.files.downloadUrl.handler(({ input }) => ({
        url: URL.createObjectURL(new Blob([`bytes of ${input.fileId}`])),
        expiresAt: new Date(Date.now() + 60_000),
      })),
    },
  }));
}

const loaded = (state: MediaState | undefined) => {
  if (typeof state !== "object") {
    throw new Error(`not loaded: ${state}`);
  }
  return state;
};

const takeId = (n: number) => directorTakeIdSchema.parse(id(n));

describe("useTakeMedia", () => {
  it("downloads each take a clip plays once, with a frame from the middle of its kept part", async () => {
    const api = storage();
    let clips = [
      clip(0),
      clip(1, { shot: shot({ kind: "photo" }), take: take(1, "photo"), seconds: 1 }),
      clip(2, { state: "missing", take: null }),
      clip(3, { state: "reviewing" }),
    ];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect.poll(() => typeof hook.current.get(takeId(0))).toBe("object");

    const video = loaded(hook.current.get(takeId(0)));
    expect(await video.blob.text()).toBe(`bytes of ${id(100)}`);
    expect(await (await fetch(video.url)).text()).toBe(`bytes of ${id(100)}`);
    expect(videoFrames).toHaveBeenCalledWith(video.url, [2]);
    expect(video.poster).toBe(`${video.url}#t=2`);

    await expect.poll(() => typeof hook.current.get(takeId(1))).toBe("object");
    const photo = loaded(hook.current.get(takeId(1)));
    expect(photo.poster).toBe(photo.url);
    expect([...hook.current.keys()].sort()).toEqual([takeId(0), takeId(1)]);

    // Another take picked for the first shot: downloaded, and the first one kept.
    clips = [clip(0, { take: take(4) }), ...clips.slice(1)];
    hook.rerender();
    await expect.poll(() => typeof hook.current.get(takeId(4))).toBe("object");
    expect(typeof hook.current.get(takeId(0))).toBe("object");
    // And picked back: nothing downloaded again.
    clips = [clip(0), ...clips.slice(1)];
    hook.rerender();
    expect(api.calls).toHaveLength(3);
  });

  it("tries a take that couldn't be downloaded again the next time it's picked", async () => {
    let refuse = true;
    const api = standIn((os) => ({
      files: {
        downloadUrl: os.files.downloadUrl.handler(({ input, errors }) => {
          if (refuse && input.fileId === id(100)) {
            throw errors.FILE_NOT_FOUND({ data: { params: {} } });
          }
          return {
            url: URL.createObjectURL(new Blob([`bytes of ${input.fileId}`])),
            expiresAt: new Date(Date.now() + 60_000),
          };
        }),
      },
    }));
    let clips = [clip(0)];
    const hook = await renderHook(() => useTakeMedia(clips), { api });
    await expect.poll(() => hook.current.get(takeId(0))).toBe("failed");
    // Another render with the same pick doesn't try again.
    hook.rerender();
    expect(api.calls).toHaveLength(1);
    refuse = false;
    clips = [clip(0, { take: take(4) })];
    hook.rerender();
    await expect.poll(() => typeof hook.current.get(takeId(4))).toBe("object");
    clips = [clip(0)];
    hook.rerender();
    await expect.poll(() => typeof hook.current.get(takeId(0))).toBe("object");
    expect(api.calls).toHaveLength(3);
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
      .poll(() => [hook.current.get(takeId(0)), hook.current.get(takeId(1))])
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
