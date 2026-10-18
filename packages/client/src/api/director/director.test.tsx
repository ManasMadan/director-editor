import { ORPCError } from "@orpc/client";
import type {
  DirectorCut,
  DirectorPlan,
  DirectorShot,
  DirectorTake,
  FileInfo,
  SceneCheck,
} from "@repo/contracts/api";
import type { FileRejection, UploadPurpose } from "@repo/contracts/files";
import {
  directorCutIdSchema,
  directorPlanIdSchema,
  directorTakeIdSchema,
  fileIdSchema,
  videoIdSchema,
} from "@repo/contracts/ids";
import { MINUTE_MS, SECOND_MS } from "@repo/contracts/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { errorCode } from "../../errors";
import { useCheckSceneMutation } from "./check-scene";
import { useLocateMutation } from "./locate";
import { useIndexShortMutation } from "./index-short";
import { takeInProgress } from "./latest";
import { useDirectorLibraryQuery } from "./library";
import { useDirectorMediaQuery } from "./media";
import { useDirectorPlanQuery } from "./plan";
import { planInProgress } from "./progress";
import { useSaveCutMutation } from "./save-cut";
import { useDirectorShotsQuery } from "./shots";
import { useSpeakMutation } from "./speak";
import { useSubmitTakeMutation } from "./submit-take";
import { useDirectorTakesQuery } from "./takes";

const videoId = videoIdSchema.parse("dQw4w9WgXcQ");

const plan = (status: DirectorPlan["status"]): DirectorPlan => ({
  id: directorPlanIdSchema.parse(id(1)),
  videoId,
  source: "user",
  status,
  stage: "queued",
  error: null,
  plan: null,
  model: null,
  audio: { status: "none", url: null },
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const take = (
  n: number,
  shotIndex: number,
  status: DirectorTake["status"],
  createdAt = n,
): DirectorTake => ({
  id: directorTakeIdSchema.parse(id(n)),
  shotIndex,
  fileId: fileIdSchema.parse(id(100 + n)),
  kind: "video",
  status,
  error: null,
  bestStartMs: null,
  bestEndMs: null,
  score: null,
  feedback: null,
  createdAt: new Date(createdAt),
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Moves the clock a second at a time, as the checks wait, until `work` settles, then a
 * second more: TanStack Query hands the screen its last changes on a timer too.
 */
async function tick<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  do {
    await vi.advanceTimersByTimeAsync(SECOND_MS);
  } while (!settled);
  await vi.advanceTimersByTimeAsync(SECOND_MS);
  return work;
}

describe("takeInProgress", () => {
  it("is true until Director has reviewed the take", () => {
    expect(takeInProgress(take(1, 0, "pending"))).toBe(true);
    expect(takeInProgress(take(1, 0, "reviewing"))).toBe(true);
    expect(takeInProgress(take(1, 0, "ready"))).toBe(false);
    expect(takeInProgress(take(1, 0, "failed"))).toBe(false);
  });
});

describe("a short's plan", () => {
  it("is asked for once when nobody has asked Director yet, and not retried", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = standIn((os) => ({
      director: {
        plan: os.director.plan.handler(() => {
          throw new ORPCError("DIRECTOR_PLAN_NOT_FOUND");
        }),
      },
    }));
    const { result } = renderHook(() => useDirectorPlanQuery(videoId), api);
    await until(() => expect(errorCode(result.current.error)).toBe("DIRECTOR_PLAN_NOT_FOUND"));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(api.calls).toEqual(["director/plan"]);
  });

  it("is followed while Director works it out, and left alone once it's done", async () => {
    for (const last of ["ready", "failed"] as const) {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const statuses = ["pending", "analyzing", last] as const;
      let asked = 0;
      const api = standIn((os) => ({
        director: {
          plan: os.director.plan.handler(({ input }) => {
            expect(input).toEqual({ videoId });
            return plan(statuses[Math.min(asked++, statuses.length - 1)] ?? last);
          }),
        },
      }));
      const { result, unmount } = renderHook(() => useDirectorPlanQuery(videoId), api);
      await until(() => expect(result.current.data?.status).toBe("pending"));
      await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
      await until(() => expect(result.current.data?.status).toBe("analyzing"));
      await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
      await until(() => expect(result.current.data?.status).toBe(last));
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      expect(asked).toBe(3);
      unmount();
      vi.useRealTimers();
    }
  });

  it("shows the plan indexing starts at once, without asking for it again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = standIn((os) => ({
      director: {
        plan: os.director.plan.handler(() => {
          throw new ORPCError("DIRECTOR_PLAN_NOT_FOUND");
        }),
        index: os.director.index.handler(({ input }) => {
          expect(input).toEqual({ url: `https://youtu.be/${videoId}` });
          return plan("pending");
        }),
      },
    }));
    const { result } = renderHook(
      () => ({ plan: useDirectorPlanQuery(videoId), index: useIndexShortMutation() }),
      api,
    );
    await until(() => expect(result.current.plan.error).not.toBeNull());
    await expect(
      result.current.index.mutateAsync({ url: `https://youtu.be/${videoId}` }),
    ).resolves.toMatchObject({ videoId, status: "pending" });
    await until(() => expect(result.current.plan.data?.status).toBe("pending"));
    expect(api.calls).toEqual(["director/plan", "director/index"]);
  });

  it("is left as it was when indexing is refused", async () => {
    const api = standIn((os) => ({
      director: {
        plan: os.director.plan.handler(() => {
          throw new ORPCError("DIRECTOR_PLAN_NOT_FOUND");
        }),
        index: os.director.index.handler(() => {
          throw new ORPCError("DIRECTOR_INDEX_LIMIT");
        }),
      },
    }));
    const { result } = renderHook(
      () => ({ plan: useDirectorPlanQuery(videoId), index: useIndexShortMutation() }),
      api,
    );
    await until(() => expect(result.current.plan.error).not.toBeNull());
    const error = await result.current.index.mutateAsync({ url: videoId }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe("DIRECTOR_INDEX_LIMIT");
    expect(result.current.plan.data).toBeUndefined();
  });
});

describe("planInProgress", () => {
  it("is true until Director has finished with the plan, either way", () => {
    expect(planInProgress(plan("pending"))).toBe(true);
    expect(planInProgress(plan("analyzing"))).toBe(true);
    expect(planInProgress(plan("ready"))).toBe(false);
    expect(planInProgress(plan("failed"))).toBe(false);
    expect(planInProgress(undefined)).toBe(false);
  });
});

describe("the library", () => {
  it("is followed while a short in it is being indexed, and left alone once none is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const seed = { ...plan("ready"), source: "seed" as const };
    const answers = [
      { templates: [plan("pending"), seed], indexUsed: true },
      { templates: [plan("analyzing"), seed], indexUsed: true },
      { templates: [plan("ready"), seed], indexUsed: true },
    ];
    let asked = 0;
    const api = standIn((os) => ({
      director: {
        library: os.director.library.handler(
          () =>
            answers[Math.min(asked++, answers.length - 1)] ?? { templates: [], indexUsed: false },
        ),
      },
    }));
    const status = () => result.current.data?.templates[0]?.status;
    const { result } = renderHook(() => useDirectorLibraryQuery(), api);
    await until(() => expect(status()).toBe("pending"));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(status()).toBe("analyzing"));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(status()).toBe("ready"));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(asked).toBe(3);
    expect(result.current.data?.indexUsed).toBe(true);
  });

  it("is asked for again once a short is indexed", async () => {
    let indexed = false;
    const api = standIn((os) => ({
      director: {
        library: os.director.library.handler(() => ({
          templates: indexed ? [plan("pending")] : [],
          indexUsed: indexed,
        })),
        index: os.director.index.handler(() => {
          indexed = true;
          return plan("pending");
        }),
      },
    }));
    const { result } = renderHook(
      () => ({ library: useDirectorLibraryQuery(), index: useIndexShortMutation() }),
      api,
    );
    await until(() => expect(result.current.library.data?.indexUsed).toBe(false));
    await result.current.index.mutateAsync({ url: `https://youtu.be/${videoId}` });
    await until(() => expect(result.current.library.data?.indexUsed).toBe(true));
    expect(api.calls).toEqual(["director/library", "director/index", "director/library"]);
  });
});

describe("the takes, shot by shot", () => {
  const shot = (index: number, takes: DirectorTake[]): DirectorShot => ({
    index,
    takes,
    pickedTakeId: null,
    needsRetake: false,
  });

  it("are not asked for until enabled (before the plan is ready)", () => {
    const api = standIn((os) => ({ director: { shots: os.director.shots.handler(() => []) } }));
    const { result } = renderHook(() => useDirectorShotsQuery(videoId, false), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.calls).toEqual([]);
  });

  it("are followed while a take is being reviewed, until every take is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers = [
      [shot(0, [take(1, 0, "reviewing")]), shot(1, [])],
      [shot(0, [take(1, 0, "ready")]), shot(1, [])],
    ];
    let asked = 0;
    const api = standIn((os) => ({
      director: {
        shots: os.director.shots.handler(({ input }) => {
          expect(input).toEqual({ videoId });
          return answers[Math.min(asked++, answers.length - 1)] ?? [];
        }),
      },
    }));
    const first = () => result.current.data?.[0]?.takes[0]?.status;
    const { result } = renderHook(() => useDirectorShotsQuery(videoId), api);
    await until(() => expect(first()).toBe("reviewing"));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(first()).toBe("ready"));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(asked).toBe(2);
  });
});

describe("checking the scene", () => {
  const check: SceneCheck = {
    inPlace: false,
    instruction: "Move about five meters left, to the tree.",
    direction: "left",
    distanceMeters: 5,
    landmark: { label: "tree", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } },
    lighting: "good",
  };
  const image = "A".repeat(200);

  it("sends the shot's frame and answers with where to go", async () => {
    const sent: unknown[] = [];
    const api = standIn((os) => ({
      director: {
        checkScene: os.director.checkScene.handler(({ input }) => {
          sent.push(input);
          return check;
        }),
      },
    }));
    const { result } = renderHook(() => useCheckSceneMutation(), api);
    await expect(result.current.mutateAsync({ videoId, shotIndex: 2, image })).resolves.toEqual(
      check,
    );
    expect(sent).toEqual([{ videoId, shotIndex: 2, image }]);
  });

  it("fails with the API's reason", async () => {
    const api = standIn((os) => ({
      director: {
        checkScene: os.director.checkScene.handler(() => {
          throw new ORPCError("AI_BUDGET_EXCEEDED");
        }),
      },
    }));
    const { result } = renderHook(() => useCheckSceneMutation(), api);
    const error = await result.current
      .mutateAsync({ videoId, shotIndex: 0, image })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("AI_BUDGET_EXCEEDED");
  });
});

describe("finding something in the camera", () => {
  it("sends what to find with the frame and answers with where it is", async () => {
    const sent: unknown[] = [];
    const found = {
      found: true,
      label: "your window",
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    };
    const api = standIn((os) => ({
      director: {
        locate: os.director.locate.handler(({ input }) => {
          sent.push(input);
          return found;
        }),
      },
    }));
    const { result } = renderHook(() => useLocateMutation(), api);
    const image = "A".repeat(200);
    await expect(result.current.mutateAsync({ target: "the window", image })).resolves.toEqual(
      found,
    );
    expect(sent).toEqual([{ target: "the window", image }]);
  });
});

describe("hearing a line in Director's voice", () => {
  it("asks for the line in the voice and answers with the link to play it from", async () => {
    const sent: unknown[] = [];
    const speech = { url: "https://files.example.com/speech.wav", expiresAt: new Date() };
    const api = standIn((os) => ({
      director: {
        speak: os.director.speak.handler(({ input }) => {
          sent.push(input);
          return speech;
        }),
      },
    }));
    const { result } = renderHook(() => useSpeakMutation(), api);
    await expect(
      result.current.mutateAsync({ text: "Step back.", voice: "Puck" }),
    ).resolves.toEqual(speech);
    expect(sent).toEqual([{ text: "Step back.", voice: "Puck" }]);
  });
});

describe("the takes for a short", () => {
  it("are not asked for until enabled", () => {
    const api = standIn((os) => ({ director: { takes: os.director.takes.handler(() => []) } }));
    const { result } = renderHook(() => useDirectorTakesQuery(videoId, false), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.calls).toEqual([]);
  });

  it("are followed while one is pending or being reviewed, until all are reviewed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lists = [
      [take(1, 0, "pending")],
      [take(1, 0, "reviewing"), take(2, 1, "ready")],
      [take(1, 0, "ready"), take(2, 1, "ready")],
    ];
    let asked = 0;
    const api = standIn((os) => ({
      director: {
        takes: os.director.takes.handler(() => lists[Math.min(asked++, lists.length - 1)] ?? []),
      },
    }));
    const statuses = () => result.current.data?.map((t) => t.status);
    const { result } = renderHook(() => useDirectorTakesQuery(videoId), api);
    await until(() => expect(statuses()).toEqual(["pending"]));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(statuses()).toEqual(["reviewing", "ready"]));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(statuses()).toEqual(["ready", "ready"]));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(asked).toBe(3);
  });
});

describe("submitting a take", () => {
  const fileId = fileIdSchema.parse(id(1));
  const file = (
    purpose: UploadPurpose,
    status: FileInfo["status"],
    rejectReason: FileRejection | null = null,
  ): FileInfo => ({
    id: fileId,
    purpose,
    status,
    filename: "take",
    contentType: "video/mp4",
    size: 5,
    rejectReason: status === "rejected" ? rejectReason : null,
    createdAt: new Date(0),
  });

  /**
   * The API for a take whose file the worker reports as `statuses`, one per look: the
   * first when the upload completes, the rest (the last repeated) when it's asked again.
   */
  function takeApi(statuses: FileInfo["status"][], rejectReason: FileRejection | null = null) {
    let looked = 0;
    const purposes: UploadPurpose[] = [];
    const added: unknown[] = [];
    const takes: DirectorTake[] = [];
    const look = (purpose: UploadPurpose) =>
      file(purpose, statuses[Math.min(looked++, statuses.length - 1)] ?? "ready", rejectReason);
    const api = standIn((os) => ({
      files: {
        createUpload: os.files.createUpload.handler(({ input }) => {
          purposes.push(input.purpose);
          return {
            file: file(input.purpose, "pending"),
            upload: {
              url: `http://storage.test/uploads/${fileId}`,
              headers: { "Content-Type": input.contentType },
              expiresAt: new Date(Date.now() + MINUTE_MS),
            },
          };
        }),
        completeUpload: os.files.completeUpload.handler(() => look(purposes[0] ?? "avatar")),
        get: os.files.get.handler(() => look(purposes[0] ?? "avatar")),
      },
      director: {
        takes: os.director.takes.handler(() => takes),
        addTake: os.director.addTake.handler(({ input }) => {
          added.push(input);
          const created = {
            ...take(takes.length + 1, input.shotIndex, "pending"),
            kind: input.kind,
          };
          takes.unshift(created);
          return created;
        }),
      },
    }));
    return { api, purposes, added };
  }

  // Object storage, as far as a presigned PUT sees it.
  const storage = vi.fn(async () => new Response(null, { status: 200 }));
  beforeEach(() => {
    storage.mockClear();
    vi.stubGlobal("fetch", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const video = () => new File(["hello"], "take.mp4", { type: "video/mp4" });

  it("uploads it, waits for the worker's check, adds it to the shot and refetches the takes", async () => {
    const { api, purposes, added } = takeApi(["processing", "processing", "ready"]);
    const { result } = renderHook(
      () => ({ takes: useDirectorTakesQuery(videoId), submit: useSubmitTakeMutation() }),
      api,
    );
    await until(() => expect(result.current.takes.data).toEqual([]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const submitted = await tick(
      result.current.submit.mutateAsync({ videoId, shotIndex: 1, kind: "video", file: video() }),
    );
    vi.useRealTimers();
    expect(submitted).toMatchObject({ shotIndex: 1, kind: "video", status: "pending" });
    expect(purposes).toEqual(["director-take-video"]);
    expect(storage).toHaveBeenCalledWith(
      `http://storage.test/uploads/${fileId}`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(added).toEqual([{ videoId, shotIndex: 1, kind: "video", fileId }]);
    await until(() => expect(result.current.takes.data).toEqual([submitted]));
    expect(api.calls).toEqual([
      "director/takes",
      "files/createUpload",
      "files/completeUpload",
      "files/get",
      "files/get",
      "director/addTake",
      "director/takes",
    ]);
  });

  it("adds a photo the worker has already passed without waiting", async () => {
    const { api, purposes, added } = takeApi(["ready"]);
    const { result } = renderHook(() => useSubmitTakeMutation(), api);
    const photo = new File(["hello"], "take.jpg", { type: "image/jpeg" });
    await expect(
      result.current.mutateAsync({ videoId, shotIndex: 0, kind: "photo", file: photo }),
    ).resolves.toMatchObject({ kind: "photo", shotIndex: 0 });
    expect(purposes).toEqual(["director-take-photo"]);
    expect(added).toEqual([{ videoId, shotIndex: 0, kind: "photo", fileId }]);
    expect(api.calls).not.toContain("files/get");
  });

  it("is turned down with the worker's reason, and never added", async () => {
    for (const [reason, code] of [
      ["FILE_INFECTED", "FILE_INFECTED"],
      [null, "FILE_UNREADABLE"],
    ] as const) {
      const { api, added } = takeApi(["pending", "rejected"], reason);
      const { result } = renderHook(() => useSubmitTakeMutation(), api);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const error = await tick(
        result.current
          .mutateAsync({ videoId, shotIndex: 0, kind: "video", file: video() })
          .catch((e: unknown) => e),
      );
      vi.useRealTimers();
      expect(errorCode(error)).toBe(code);
      expect(error).toHaveProperty("message", `file rejected: ${code}`);
      expect(added).toEqual([]);
    }
  });

  it("gives up when the worker hasn't checked it within two minutes", async () => {
    const { api, added } = takeApi(["processing"]);
    const { result } = renderHook(() => useSubmitTakeMutation(), api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    const error = await tick(
      result.current
        .mutateAsync({ videoId, shotIndex: 0, kind: "video", file: video() })
        .catch((e: unknown) => e),
    );
    expect(errorCode(error)).toBe("FILE_NOT_READY");
    expect(Date.now() - started).toBeGreaterThan(2 * MINUTE_MS);
    expect(api.calls.filter((call) => call === "files/get").length).toBeGreaterThan(1);
    expect(added).toEqual([]);
  });
});

const cut = (n: number, publish: DirectorCut["publish"]["status"] = "none"): DirectorCut => ({
  id: directorCutIdSchema.parse(id(n)),
  planId: directorPlanIdSchema.parse(id(1)),
  videoId,
  templateTitle: "Morning routine",
  title: "Morning routine",
  picks: { 0: directorTakeIdSchema.parse(id(1)) },
  fileId: fileIdSchema.parse(id(200 + n)),
  durationMs: 2_000,
  createdAt: new Date(n),
  publish: { status: publish, youtubeVideoId: null, visibility: null },
});

describe("the member's media", () => {
  it("is followed while a cut is being published, and left alone after", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lists = [
      [cut(2, "uploading"), cut(1)],
      [cut(2, "published"), cut(1)],
    ];
    let asked = 0;
    const api = standIn((os) => ({
      director: {
        media: os.director.media.handler(() => lists[Math.min(asked++, lists.length - 1)] ?? []),
      },
    }));
    const statuses = () => result.current.data?.map((c) => c.publish.status);
    const { result } = renderHook(() => useDirectorMediaQuery(), api);
    await until(() => expect(statuses()).toEqual(["uploading", "none"]));
    await vi.advanceTimersByTimeAsync(3 * SECOND_MS);
    await until(() => expect(statuses()).toEqual(["published", "none"]));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(asked).toBe(2);
  });
});

describe("saving a cut", () => {
  const fileId = fileIdSchema.parse(id(9));
  const picks = { 0: directorTakeIdSchema.parse(id(1)), 1: directorTakeIdSchema.parse(id(2)) };
  const file = (status: FileInfo["status"]): FileInfo => ({
    id: fileId,
    purpose: "director-cut-video",
    status,
    filename: "director-cut.webm",
    contentType: "video/webm",
    size: 5,
    rejectReason: status === "rejected" ? "FILE_INFECTED" : null,
    createdAt: new Date(0),
  });

  /** The API for a cut whose file the worker reports as `statuses`, one per look. */
  function cutApi(statuses: FileInfo["status"][]) {
    let looked = 0;
    const purposes: UploadPurpose[] = [];
    const saved: unknown[] = [];
    const media: DirectorCut[] = [];
    const look = () => file(statuses[Math.min(looked++, statuses.length - 1)] ?? "ready");
    const api = standIn((os) => ({
      files: {
        createUpload: os.files.createUpload.handler(({ input }) => {
          purposes.push(input.purpose);
          return {
            file: file("pending"),
            upload: {
              url: `http://storage.test/uploads/${fileId}`,
              headers: { "Content-Type": input.contentType },
              expiresAt: new Date(Date.now() + MINUTE_MS),
            },
          };
        }),
        completeUpload: os.files.completeUpload.handler(look),
        get: os.files.get.handler(look),
      },
      director: {
        media: os.director.media.handler(() => media),
        saveCut: os.director.saveCut.handler(({ input }) => {
          saved.push(input);
          const created = { ...cut(media.length + 1), picks: input.picks, title: input.title };
          media.unshift(created);
          return created;
        }),
      },
    }));
    return { api, purposes, saved };
  }

  const storage = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }),
  );
  beforeEach(() => {
    storage.mockClear();
    vi.stubGlobal("fetch", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const video = () => new File(["hello"], "director-cut.webm", { type: "video/webm" });

  it("uploads the video, waits for the worker's check, saves the cut and refetches the media", async () => {
    const { api, purposes, saved } = cutApi(["processing", "ready"]);
    const { result } = renderHook(
      () => ({ media: useDirectorMediaQuery(), save: useSaveCutMutation() }),
      api,
    );
    await until(() => expect(result.current.media.data).toEqual([]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const created = await tick(
      result.current.save.mutateAsync({ videoId, picks, title: "My morning", file: video() }),
    );
    vi.useRealTimers();
    expect(created).toMatchObject({ title: "My morning", picks });
    expect(purposes).toEqual(["director-cut-video"]);
    expect(storage).toHaveBeenCalledWith(
      `http://storage.test/uploads/${fileId}`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(saved).toEqual([{ videoId, picks, title: "My morning", fileId }]);
    await until(() => expect(result.current.media.data).toEqual([created]));
  });

  it("is dropped, never saved, when cancelled while the video uploads", async () => {
    const { api, saved } = cutApi(["ready"]);
    const cancel = new AbortController();
    storage.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      // The member leaves while the bytes are on their way.
      expect(init?.signal).toBe(cancel.signal);
      cancel.abort();
      return new Response(null, { status: 200 });
    });
    const { result } = renderHook(() => useSaveCutMutation(), api);
    const error = await result.current
      .mutateAsync({ videoId, picks, title: "Mine", file: video(), signal: cancel.signal })
      .catch((e: unknown) => e);
    expect(error).toHaveProperty("name", "AbortError");
    expect(saved).toEqual([]);
  });

  it("stops waiting for the worker's check once cancelled", async () => {
    const { api, saved } = cutApi(["processing"]);
    const cancel = new AbortController();
    const { result } = renderHook(() => useSaveCutMutation(), api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const saving = result.current
      .mutateAsync({ videoId, picks, title: "Mine", file: video(), signal: cancel.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2 * SECOND_MS);
    cancel.abort();
    const error = await tick(saving);
    vi.useRealTimers();
    expect(error).toHaveProperty("name", "AbortError");
    const looks = api.calls.filter((call) => call === "files/get").length;
    expect(looks).toBeLessThanOrEqual(3);
    expect(saved).toEqual([]);
  });

  it("is turned down with the worker's reason, and never saved", async () => {
    const { api, saved } = cutApi(["pending", "rejected"]);
    const { result } = renderHook(() => useSaveCutMutation(), api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const error = await tick(
      result.current
        .mutateAsync({ videoId, picks, title: "My morning", file: video() })
        .catch((e: unknown) => e),
    );
    vi.useRealTimers();
    expect(errorCode(error)).toBe("FILE_INFECTED");
    expect(saved).toEqual([]);
  });

  it("waits longer than a take for the worker to check a whole video, then gives up", async () => {
    const { api, saved } = cutApi(["processing"]);
    const { result } = renderHook(() => useSaveCutMutation(), api);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    const error = await tick(
      result.current
        .mutateAsync({ videoId, picks, title: "Mine", file: video() })
        .catch((e: unknown) => e),
    );
    expect(Date.now() - started).toBeGreaterThan(5 * MINUTE_MS);
    vi.useRealTimers();
    expect(errorCode(error)).toBe("FILE_NOT_READY");
    expect(saved).toEqual([]);
  });
});
