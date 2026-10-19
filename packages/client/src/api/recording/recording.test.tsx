import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import type {
  RecordingAttempt,
  RecordingSession,
  RecordingSessionDetail,
} from "@repo/contracts/api";
import { recordingSessionIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { errorCode } from "../../errors";
import { useAddRecordingPartMutation } from "./add-part";
import { useFinishRecordingMutation } from "./finish";
import { useMarkAttemptMutation } from "./mark";
import { usePauseRecordingMutation } from "./pause";
import { useRemoveRecordingMutation } from "./remove";
import { useResumeRecordingMutation } from "./resume";
import { attemptsInProgress, nearRecordingLimit, useRecordingSessionQuery } from "./session";
import { useRecordingSessionsQuery } from "./sessions";
import {
  defaultSliceStore,
  IndexedDbSliceStore,
  keyOf,
  MemorySliceStore,
  type QueuedItem,
  type QueuedSlice,
} from "./slice-store";
import { useStartRecordingMutation } from "./start";
import { RETRY_DELAYS_MS, retryDelay, useSliceUploader } from "./upload-slices";

const SESSION = recordingSessionIdSchema.parse(id(1));
const created = new Date(0);
const session: RecordingSession = {
  id: SESSION,
  videoId: videoIdSchema.parse("dQw4w9WgXcQ"),
  status: "recording",
  paused: false,
  recordedMs: 0,
  bytes: 0,
  createdAt: created,
  finishedAt: null,
  expiresAt: created,
};
const attempt = (status: RecordingAttempt["status"]): RecordingAttempt => ({
  id: id(2) as RecordingAttempt["id"],
  number: 1,
  shotIndex: 0,
  partIndex: 0,
  line: null,
  note: null,
  startMs: 1_000,
  endMs: status === "open" ? null : 4_000,
  status,
  clip: null,
  takeId: null,
  fileId: null,
  error: null,
  createdAt: created,
});
const detail = (attempts: RecordingAttempt[]): RecordingSessionDetail => ({
  ...session,
  parts: [],
  attempts,
});

const slice = (index: number, partIndex = 0): QueuedSlice => ({
  kind: "slice",
  sessionId: SESSION,
  partIndex,
  index,
  startMs: index * 10_000,
  durationMs: 10_000,
  bytes: new Blob([`slice-${partIndex}-${index}`], { type: "video/webm" }),
});
const partEnd = (sliceCount: number, partIndex = 0): QueuedItem => ({
  kind: "part-end",
  sessionId: SESSION,
  partIndex,
  sliceCount,
});

// Object storage, as far as a presigned PUT sees it: takes the bytes, or refuses.
let storage: Server;
let storageUrl: string;
let storageStatus = 200;
const stored: { path: string; body: string; type: string | undefined }[] = [];
beforeAll(async () => {
  storage = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    if (storageStatus === 200) {
      stored.push({ path: request.url ?? "", body, type: request.headers["content-type"] });
    }
    // No kept-alive connection: one opened under a test's fake clock never times out
    // right for the next test.
    response.writeHead(storageStatus, { connection: "close" }).end();
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => storage.close(() => resolve())));
afterEach(() => {
  stored.length = 0;
  storageStatus = 200;
  vi.useRealTimers();
});

describe("where queued slices wait", () => {
  it("sends a part's slices from its first, then its end, part by part", async () => {
    const store = new MemorySliceStore();
    for (const item of [partEnd(2), slice(1), slice(0, 1), slice(0)]) {
      await store.put(item);
    }
    expect((await store.all()).map(keyOf)).toEqual([
      `${SESSION}/000/0000`,
      `${SESSION}/000/0001`,
      `${SESSION}/000/end`,
      `${SESSION}/001/0000`,
    ]);
    await store.remove(slice(0));
    expect(await store.all()).toHaveLength(3);
  });

  it("keeps them in IndexedDB, where the browser has it", async () => {
    const browser = fakeIndexedDb();
    const store = new IndexedDbSliceStore(browser.factory);
    await store.put(slice(1));
    await store.put(slice(0));
    await store.put(partEnd(2));
    // Another page (the shoot screen opened again) reads what this one left.
    const again = new IndexedDbSliceStore(browser.factory);
    const items = await again.all();
    expect(items.map(keyOf)).toEqual([
      `${SESSION}/000/0000`,
      `${SESSION}/000/0001`,
      `${SESSION}/000/end`,
    ]);
    expect(items[0]).toEqual(slice(0));
    expect(await again.first()).toEqual(slice(0));
    await again.remove(slice(0));
    expect(await store.all()).toHaveLength(2);
    expect((await store.first())?.kind).toBe("slice");
    expect(await new IndexedDbSliceStore(fakeIndexedDb().factory).first()).toBeNull();
  });

  it("reads only the next to send, in IndexedDB's order and memory's alike", async () => {
    const memory = new MemorySliceStore();
    expect(await memory.first()).toBeNull();
    // Part 10 after part 9, and a part's slices before its end, however they were queued.
    for (const item of [partEnd(1, 10), slice(0, 10), slice(3, 9)]) {
      await memory.put(item);
    }
    expect(await memory.first()).toEqual(slice(3, 9));
    await memory.remove(slice(3, 9));
    expect(await memory.first()).toEqual(slice(0, 10));
  });

  it("fails when IndexedDB does", async () => {
    await expect(
      new IndexedDbSliceStore(fakeIndexedDb({ open: true }).factory).all(),
    ).rejects.toThrow("blocked");
    const reads = new IndexedDbSliceStore(fakeIndexedDb({ read: true }).factory);
    await expect(reads.all()).rejects.toThrow("unreadable");
    const writes = new IndexedDbSliceStore(fakeIndexedDb({ write: true }).factory);
    await expect(writes.put(slice(0))).rejects.toThrow("quota");
    const aborts = new IndexedDbSliceStore(fakeIndexedDb({ abort: true }).factory);
    await expect(aborts.put(slice(0))).rejects.toThrow("aborted");
  });

  it("is IndexedDB in a browser, and memory where there's none", () => {
    expect(defaultSliceStore()).toBeInstanceOf(MemorySliceStore);
    vi.stubGlobal("indexedDB", fakeIndexedDb().factory);
    expect(defaultSliceStore()).toBeInstanceOf(IndexedDbSliceStore);
    vi.unstubAllGlobals();
  });
});

describe("uploading the recording", () => {
  /** The API as the uploader sees it; `stored` slices are signed as already uploaded. */
  function recordingApi({
    alreadyStored = [] as number[],
    refuse = null as string | null,
    hold = Promise.resolve(),
  } = {}) {
    const completed: string[] = [];
    const closed: number[] = [];
    const api = standIn((os) => ({
      recording: {
        uploadSlice: os.recording.uploadSlice.handler(async ({ input }) => {
          await hold;
          if (refuse) {
            throw new ORPCError(refuse);
          }
          return {
            upload: alreadyStored.includes(input.index)
              ? null
              : {
                  url: `${storageUrl}/recordings/${input.partIndex}/${input.index}`,
                  headers: {
                    "Content-Type": "video/webm",
                    "Content-Length": String(input.size),
                  },
                  expiresAt: new Date(Date.now() + 60_000),
                },
          };
        }),
        completeSlice: os.recording.completeSlice.handler(({ input }) => {
          completed.push(`${input.partIndex}/${input.index}`);
          return session;
        }),
        closePart: os.recording.closePart.handler(({ input }) => {
          closed.push(input.sliceCount);
          return {
            index: input.index,
            camera: "front",
            contentType: "video/webm",
            sliceCount: input.sliceCount,
            uploaded: [],
          };
        }),
      },
    }));
    return { api, completed, closed };
  }

  it("sends each slice straight to storage, then completes it, and the part's end after", async () => {
    const { api, completed, closed } = recordingApi({ alreadyStored: [1] });
    const store = new MemorySliceStore();
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await result.current.enqueue(slice(0));
    await result.current.enqueue(slice(1));
    await result.current.enqueue(partEnd(2));
    // What's kept until it's sent: the shoot screen reads it to end a dead tab's parts.
    expect((await result.current.leftover()).length).toBeGreaterThan(0);
    await result.current.send();
    await until(() => expect(result.current.pending).toBe(0));
    expect(await result.current.leftover()).toEqual([]);
    expect(stored).toEqual([{ path: "/recordings/0/0", body: "slice-0-0", type: "video/webm" }]);
    expect(completed).toEqual(["0/0", "0/1"]);
    expect(closed).toEqual([2]);
    expect(result.current).toMatchObject({ behindMs: 0, error: null });
    unmount();
  });

  it("sends what an earlier visit left queued as soon as it's back", async () => {
    const { api, completed } = recordingApi();
    const store = new MemorySliceStore();
    await store.put(slice(0));
    await store.put(slice(1));
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await until(() => expect(completed).toEqual(["0/0", "0/1"]));
    await until(() => expect(result.current.pending).toBe(0));
    unmount();
  });

  it("tries again later, waiting longer each time, and says how far behind it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    storageStatus = 503;
    const { api, completed } = recordingApi();
    const store = new MemorySliceStore();
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await result.current.enqueue(slice(0));
    await result.current.enqueue(slice(1));
    await until(() =>
      expect(result.current).toMatchObject({ pending: 2, behindMs: 20_000, error: "INTERNAL" }),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
    expect(completed).toEqual([]);
    storageStatus = 200;
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] ?? 0);
    await until(() => expect(result.current).toMatchObject({ pending: 0, error: null }));
    expect(completed).toEqual(["0/0", "0/1"]);
    unmount();
  });

  it("waits longer after each failure in a row, up to the longest", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("drops a slice the API will never take, and says why", async () => {
    for (const refusal of ["RECORDING_LIMIT_REACHED", "FORBIDDEN", "RECORDING_SLICE_INVALID"]) {
      const { api } = recordingApi({ refuse: refusal });
      const store = new MemorySliceStore();
      const { result, unmount } = renderHook(() => useSliceUploader(store), api);
      await result.current.enqueue(slice(0));
      await until(() => expect(result.current).toMatchObject({ pending: 0, error: refusal }));
      // The refusal itself, for the shoot screen to say what was lost and why.
      expect(errorCode(result.current.lost)).toBe(refusal);
      unmount();
    }
  });

  it("is full from five minutes queued until it's below, and never refuses a slice", async () => {
    // The connection is gone: the first slice is still on its way while the rest queue.
    let back = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      back = resolve;
    });
    const { api, completed } = recordingApi({ hold });
    const store = new MemorySliceStore();
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    for (let index = 0; index < 29; index++) {
      await result.current.enqueue(slice(index));
    }
    await until(() => expect(result.current).toMatchObject({ pending: 29, full: false }));
    await result.current.enqueue(slice(29));
    await until(() =>
      expect(result.current).toMatchObject({ pending: 30, behindMs: 300_000, full: true }),
    );
    // A slice past the five minutes is kept all the same (the recorder's last, while the
    // screen pauses): one missing from the middle of a part leaves a hole no take can be
    // cut across.
    await result.current.enqueue(slice(30));
    await result.current.enqueue(partEnd(31));
    await until(() =>
      expect(result.current).toMatchObject({ pending: 32, behindMs: 310_000, full: true }),
    );
    back();
    await result.current.send();
    await until(() =>
      expect(result.current).toMatchObject({ pending: 0, behindMs: 0, full: false }),
    );
    expect(completed).toHaveLength(31);
    unmount();
  });

  it("takes an item once it's kept, without waiting for what's ahead of it to send", async () => {
    let answer = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { api, completed, closed } = recordingApi({ hold });
    const store = new MemorySliceStore();
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    // A camera flip ends a part here: it mustn't wait for the queue to empty.
    await result.current.enqueue(slice(0));
    await result.current.enqueue(partEnd(1));
    expect(await store.all()).toHaveLength(2);
    expect(completed).toEqual([]);
    answer();
    await result.current.send();
    await until(() => expect(result.current.pending).toBe(0));
    expect(completed).toEqual(["0/0"]);
    expect(closed).toEqual([1]);
    unmount();
  });

  it("stops when the shoot screen closes, keeping what's queued", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    storageStatus = 503;
    const { api } = recordingApi();
    const store = new MemorySliceStore();
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await result.current.enqueue(slice(0));
    unmount();
    storageStatus = 200;
    // Past when it would have tried again.
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
    expect(stored).toEqual([]);
    expect(await store.all()).toHaveLength(1);
  });

  it("fails a pass the store can't be read for, and tries afresh the next time", async () => {
    const { api, completed } = recordingApi();
    const store = new MemorySliceStore();
    vi.spyOn(store, "all").mockRejectedValueOnce(new Error("storage gone"));
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await until(() => expect(result.current.error).toBe("INTERNAL"));
    await result.current.enqueue(slice(0));
    await until(() => expect(completed).toEqual(["0/0"]));
    unmount();
  });

  it("says a slice the device couldn't keep is lost, and keeps taking the rest", async () => {
    const { api, completed } = recordingApi();
    const store = new MemorySliceStore();
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("quota"));
    const { result, unmount } = renderHook(() => useSliceUploader(store), api);
    await result.current.enqueue(slice(0));
    await until(() => expect(result.current).toMatchObject({ pending: 0, error: "INTERNAL" }));
    expect(result.current.lost).toBeInstanceOf(Error);
    await result.current.enqueue(slice(1));
    await until(() => expect(completed).toEqual(["0/1"]));
    await until(() => expect(result.current).toMatchObject({ error: null, lost: null }));
    unmount();
  });

  it("keeps its queue in IndexedDB by default where there is one", async () => {
    const { api } = recordingApi();
    const { result, unmount } = renderHook(() => useSliceUploader(), api);
    expect(result.current.pending).toBe(0);
    unmount();
  });
});

describe("a recording session", () => {
  it("is started, marked, paused, resumed, finished and deleted through the API", async () => {
    const calls: string[] = [];
    const api = standIn((os) => ({
      recording: {
        start: os.recording.start.handler(() => detail([])),
        addPart: os.recording.addPart.handler(({ input }) => ({
          index: input.index,
          camera: input.camera,
          contentType: input.contentType,
          sliceCount: null,
          uploaded: [],
        })),
        mark: os.recording.mark.handler(() => attempt("open")),
        pause: os.recording.pause.handler(() => ({ ...session, paused: true })),
        resume: os.recording.resume.handler(() => session),
        finish: os.recording.finish.handler(() => ({ ...session, status: "done" as const })),
        remove: os.recording.remove.handler(() => ({ removed: true as const })),
        sessions: os.recording.sessions.handler(() => {
          calls.push("sessions");
          return [session];
        }),
      },
    }));
    const { result, unmount } = renderHook(
      () => ({
        start: useStartRecordingMutation(),
        addPart: useAddRecordingPartMutation(),
        mark: useMarkAttemptMutation(),
        pause: usePauseRecordingMutation(),
        resume: useResumeRecordingMutation(),
        finish: useFinishRecordingMutation(),
        remove: useRemoveRecordingMutation(),
        sessions: useRecordingSessionsQuery(),
      }),
      api,
    );
    await until(() => expect(result.current.sessions.data).toEqual([session]));
    const { current } = result;
    expect((await current.start.mutateAsync({ videoId: "dQw4w9WgXcQ" })).id).toBe(SESSION);
    await current.addPart.mutateAsync({
      sessionId: SESSION,
      index: 0,
      camera: "front",
      contentType: "video/webm",
    });
    const marked = await current.mark.mutateAsync({
      sessionId: SESSION,
      attempt: 1,
      event: "start",
      shotIndex: 0,
      partIndex: 0,
      atMs: 1_000,
    });
    expect(marked.status).toBe("open");
    expect(
      (await current.pause.mutateAsync({ sessionId: SESSION, partIndex: 0, atMs: 2_000 })).paused,
    ).toBe(true);
    await current.resume.mutateAsync({ sessionId: SESSION, partIndex: 0, atMs: 2_000 });
    expect((await current.finish.mutateAsync({ sessionId: SESSION })).status).toBe("done");
    expect(await current.remove.mutateAsync({ sessionId: SESSION })).toEqual({ removed: true });
    // Each change brings the session list up to date.
    await until(() => expect(calls.length).toBeGreaterThan(1));
    unmount();
  });

  it("is read once there's one, and followed while its attempts become takes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers = [detail([attempt("clipping")]), detail([attempt("clipped")])];
    let asked = 0;
    const api = standIn((os) => ({
      recording: {
        session: os.recording.session.handler(() => answers[Math.min(asked++, 1)] ?? detail([])),
      },
    }));
    const none = renderHook(() => useRecordingSessionQuery(null), api);
    expect(none.result.current.fetchStatus).toBe("idle");
    none.unmount();
    const { result, unmount } = renderHook(() => useRecordingSessionQuery(SESSION), api);
    await until(() => expect(result.current.data?.attempts[0]?.status).toBe("clipping"));
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => expect(result.current.data?.attempts[0]?.status).toBe("clipped"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked).toBe(2);
    unmount();
  });

  it("is near its limit from 17 minutes recorded", () => {
    expect(nearRecordingLimit({ ...session, recordedMs: 16 * 60_000 })).toBe(false);
    expect(nearRecordingLimit({ ...session, recordedMs: 17 * 60_000 })).toBe(true);
  });

  it("has attempts in progress while one is waiting for its footage or at the clipper", () => {
    expect(attemptsInProgress(undefined)).toBe(false);
    expect(attemptsInProgress(detail([attempt("waiting")]))).toBe(true);
    expect(attemptsInProgress(detail([attempt("open"), attempt("failed")]))).toBe(false);
  });
});

/**
 * IndexedDB as far as the slice store uses it: one database of object stores keyed by a
 * path, requests that succeed or fail by event, and transactions that commit or abort.
 * `failing` makes one kind of call fail the way a browser's does.
 */
function fakeIndexedDb(
  failing: { open?: boolean; read?: boolean; write?: boolean; abort?: boolean } = {},
) {
  const stores = new Map<string, Map<string, unknown>>();
  const later = (fn: () => void) => queueMicrotask(fn);

  function request<T>(outcome: () => T, error?: string) {
    const req: {
      result?: T;
      error: Error | null;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    } = { error: null, onsuccess: null, onerror: null };
    later(() => {
      if (error) {
        req.error = new Error(error);
        req.onerror?.();
      } else {
        req.result = outcome();
        req.onsuccess?.();
      }
    });
    return req;
  }

  const database = {
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    transaction(name: string, mode = "readonly") {
      const items = stores.get(name) ?? new Map<string, unknown>();
      const tx = {
        error: null as Error | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          put(value: { key: string }) {
            items.set(value.key, value);
          },
          delete(key: string) {
            items.delete(key);
          },
          getAll: () => request(() => [...items.values()], failing.read ? "unreadable" : undefined),
          openCursor: () =>
            request(() => {
              const [key] = [...items.keys()].sort();
              return key === undefined ? null : { value: items.get(key) };
            }),
        }),
      };
      if (mode === "readwrite") {
        later(() => {
          if (failing.write) {
            tx.error = new Error("quota exceeded");
            tx.onerror?.();
          } else if (failing.abort) {
            tx.error = new Error("aborted");
            tx.onabort?.();
          } else {
            tx.oncomplete?.();
          }
        });
      }
      return tx;
    },
  };

  const factory = {
    open() {
      const req = {
        result: database,
        error: null as Error | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      later(() => {
        if (failing.open) {
          req.error = new Error("blocked");
          req.onerror?.();
          return;
        }
        // A new database is upgraded (its stores made) before it opens.
        if (!stores.has("items")) {
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory };
}
