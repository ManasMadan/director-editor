import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ORPCError } from "@orpc/client";
import type { DirectorPlan, FileInfo } from "@repo/contracts/api";
import { directorSeeds } from "@repo/contracts/director-seeds";
import { directorPlanIdSchema, fileIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { required } from "@repo/contracts/objects";
import { MINUTE_MS } from "@repo/contracts/time";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Implement, id, renderHook, standIn, until } from "../../../test/stand-in";
import { useBrainstormMutation } from "./brainstorm";
import { useBriefPhotoMutation } from "./brief-photo";
import { useCreateTemplateMutation } from "./create-template";
import { useEditPlanMutation } from "./edit-plan";
import { useDirectorLibraryQuery } from "./library";
import { useDirectorPlanQuery } from "./plan";

const videoId = videoIdSchema.parse("Zx9_created");
const seed = required(directorSeeds[0], "a committed seed");
const brief = { text: "My morning coffee routine", messages: [], photos: [] };

const created = (status: DirectorPlan["status"]): DirectorPlan => ({
  id: directorPlanIdSchema.parse(id(1)),
  videoId,
  source: "created",
  status,
  stage: status === "ready" ? "ready" : "queued",
  error: null,
  plan: status === "ready" ? { ...seed.plan, assets: [], edits: [] } : null,
  model: null,
  audio: { status: "none", url: null },
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

// Object storage, as a presigned PUT sees it: takes the bytes.
let storage: Server;
let storageUrl: string;
beforeAll(async () => {
  // The bytes themselves are the upload test's to check (files/upload.test.tsx).
  storage = createServer((request, response) => {
    request.resume().on("end", () => response.writeHead(200).end());
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}/uploads/${id(9)}`;
});
afterAll(() => new Promise<void>((resolve) => storage.close(() => resolve())));

/** The plan's own route, saying there's none: what the screen shows came from elsewhere. */
const notFound = (os: Implement) =>
  os.director.plan.handler(() => {
    throw new ORPCError("DIRECTOR_PLAN_NOT_FOUND");
  });

describe("a template the member describes", () => {
  it("talks it through with Director, a turn at a time", async () => {
    const reply = { reply: "Lovely. What do you drink it from?", ready: false, questionsLeft: 2 };
    const asked: unknown[] = [];
    const api = standIn((os) => ({
      director: {
        brainstorm: os.director.brainstorm.handler(({ input }) => {
          asked.push(input);
          return reply;
        }),
      },
    }));
    const { result } = renderHook(() => useBrainstormMutation(), api);
    await expect(result.current.mutateAsync(brief)).resolves.toEqual(reply);
    expect(asked).toEqual([brief]);
  });

  it("uploads a photo for the brief and waits until the worker has passed it", async () => {
    const ready: FileInfo = {
      id: fileIdSchema.parse(id(9)),
      purpose: "director-brief-photo",
      status: "ready",
      filename: "kitchen.jpg",
      contentType: "image/jpeg",
      size: 5,
      rejectReason: null,
      createdAt: new Date(0),
    };
    const purposes: string[] = [];
    const api = standIn((os) => ({
      files: {
        createUpload: os.files.createUpload.handler(({ input }) => {
          purposes.push(input.purpose);
          return {
            file: { ...ready, status: "pending" as const },
            upload: {
              url: storageUrl,
              headers: { "Content-Type": input.contentType },
              expiresAt: new Date(Date.now() + MINUTE_MS),
            },
          };
        }),
        completeUpload: os.files.completeUpload.handler(() => ready),
      },
    }));
    const { result } = renderHook(() => useBriefPhotoMutation(), api);
    const photo = new File(["hello"], "kitchen.jpg", { type: "image/jpeg" });
    await expect(result.current.mutateAsync(photo)).resolves.toMatchObject({
      id: id(9),
      status: "ready",
    });
    expect(purposes).toEqual(["director-brief-photo"]);
  });

  it("is asked for, shows in the library and its plan is there at once", async () => {
    let made = false;
    const api = standIn((os) => ({
      director: {
        library: os.director.library.handler(() => ({
          templates: made ? [created("pending")] : [],
          indexUsed: false,
        })),
        create: os.director.create.handler(({ input }) => {
          expect(input).toEqual(brief);
          made = true;
          return created("pending");
        }),
        plan: notFound(os),
      },
    }));
    const { result } = renderHook(
      () => ({
        library: useDirectorLibraryQuery(),
        plan: useDirectorPlanQuery(videoId),
        create: useCreateTemplateMutation(),
      }),
      api,
    );
    await until(() => expect(result.current.library.data?.templates).toEqual([]));
    await until(() => expect(result.current.plan.isError).toBe(true));
    await result.current.create.mutateAsync(brief);
    await until(() => expect(result.current.library.data?.templates).toHaveLength(1));
    // The plan comes from the answer: the API still says it has none.
    expect(result.current.plan.data?.status).toBe("pending");
  });

  it("keeps the member's own changes to its shots, in its plan and the library", async () => {
    const edited = { ...seed.plan, title: "My coffee, my way", assets: [], edits: [] };
    let saved = false;
    const api = standIn((os) => ({
      director: {
        library: os.director.library.handler(() => ({
          templates: [saved ? { ...created("ready"), plan: edited } : created("ready")],
          indexUsed: false,
        })),
        editPlan: os.director.editPlan.handler(({ input }) => {
          expect(input).toMatchObject({ videoId, plan: { title: "My coffee, my way" } });
          saved = true;
          return { ...created("ready"), plan: edited };
        }),
        plan: notFound(os),
      },
    }));
    const { result } = renderHook(
      () => ({
        library: useDirectorLibraryQuery(),
        plan: useDirectorPlanQuery(videoId),
        edit: useEditPlanMutation(),
      }),
      api,
    );
    await until(() => expect(result.current.library.data?.templates).toHaveLength(1));
    await until(() => expect(result.current.plan.isError).toBe(true));
    await result.current.edit.mutateAsync({ videoId, plan: edited });
    await until(() =>
      expect(result.current.library.data?.templates[0]?.plan?.title).toBe("My coffee, my way"),
    );
    expect(result.current.plan.data?.plan?.title).toBe("My coffee, my way");
  });
});
