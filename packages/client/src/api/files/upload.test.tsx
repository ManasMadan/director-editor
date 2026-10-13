import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FileInfo } from "@repo/contracts/api";
import { fileIdSchema } from "@repo/contracts/ids";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { useFileQuery } from "./get";
import { checkUpload, UploadFailedError, useUploadFileMutation } from "./upload";

const file = (status: FileInfo["status"]): FileInfo => ({
  id: fileIdSchema.parse(id(1)),
  purpose: "avatar",
  status,
  filename: "me.png",
  contentType: "image/png",
  size: 5,
  rejectReason: status === "rejected" ? "FILE_INFECTED" : null,
  createdAt: new Date(0),
});

// Object storage, as far as a presigned PUT sees it: takes the bytes, or refuses.
let storage: Server;
let storageUrl: string;
let storageStatus = 200;
const stored: { method: string; headers: IncomingHttpHeaders; body: string }[] = [];
beforeAll(async () => {
  storage = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    stored.push({ method: request.method ?? "", headers: request.headers, body });
    response.writeHead(storageStatus).end();
  });
  await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
  storageUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}/uploads/${id(1)}`;
});
afterAll(() => new Promise<void>((resolve) => storage.close(() => resolve())));
afterEach(() => {
  stored.length = 0;
  storageStatus = 200;
  vi.useRealTimers();
});

describe("checkUpload", () => {
  it("turns down a file of the wrong type or size before anything is sent", () => {
    expect(checkUpload("avatar", { type: "application/pdf", size: 10 })).toEqual({
      code: "FILE_TYPE_NOT_ALLOWED",
      params: { types: "image/png, image/jpeg, image/webp, image/gif" },
    });
    expect(checkUpload("avatar", { type: "image/png", size: 6_000_000 })).toEqual({
      code: "FILE_TOO_LARGE",
      params: { maxBytes: 5_000_000 },
    });
    expect(checkUpload("avatar", { type: "image/png", size: 10 })).toBeNull();
  });
});

describe("uploading a file", () => {
  const uploadApi = () =>
    standIn((os) => ({
      files: {
        createUpload: os.files.createUpload.handler(({ input }) => ({
          file: { ...file("pending"), filename: input.filename, size: input.size },
          upload: {
            url: storageUrl,
            // Signed along with the URL; the browser sets Content-Length itself.
            headers: { "Content-Type": input.contentType, "Content-Length": String(input.size) },
            expiresAt: new Date(Date.now() + 60_000),
          },
        })),
        completeUpload: os.files.completeUpload.handler(() => file("processing")),
      },
    }));

  it("sends the bytes straight to storage, then completes the upload", async () => {
    const api = uploadApi();
    const { result } = renderHook(() => useUploadFileMutation(), api);
    const picture = new File(["hello"], "me.png", { type: "image/png" });
    await expect(
      result.current.mutateAsync({ purpose: "avatar", file: picture }),
    ).resolves.toMatchObject({ id: id(1), status: "processing" });
    expect(stored).toMatchObject([
      {
        method: "PUT",
        body: "hello",
        headers: { "content-type": "image/png", "content-length": "5" },
      },
    ]);
    expect(api.calls).toEqual(["files/createUpload", "files/completeUpload"]);
  });

  it("fails without completing when storage refuses the bytes", async () => {
    storageStatus = 403;
    const api = uploadApi();
    const { result } = renderHook(() => useUploadFileMutation(), api);
    const error = await result.current
      .mutateAsync({
        purpose: "avatar",
        file: new File(["hello"], "me.png", { type: "image/png" }),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadFailedError);
    expect((error as UploadFailedError).status).toBe(403);
    expect(api.calls).toEqual(["files/createUpload"]);
  });
});

describe("a file's status", () => {
  const statusApi = (statuses: FileInfo["status"][]) => {
    let asked = 0;
    const api = standIn((os) => ({
      files: {
        get: os.files.get.handler(() =>
          file(statuses[Math.min(asked++, statuses.length - 1)] ?? "ready"),
        ),
      },
    }));
    return { api, asked: () => asked };
  };

  it("is asked for only once there is a file", async () => {
    const { api, asked } = statusApi(["ready"]);
    const { result } = renderHook(() => useFileQuery(null), api);
    expect(result.current.fetchStatus).toBe("idle");
    expect(asked()).toBe(0);
  });

  it("is polled while the worker checks the file, until it's ready or rejected", async () => {
    for (const last of ["ready", "rejected"] as const) {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { api, asked } = statusApi(["pending", "processing", last]);
      const { result, unmount } = renderHook(() => useFileQuery(id(1)), api);
      await until(() => expect(result.current.data?.status).toBe("pending"));
      await vi.advanceTimersByTimeAsync(3_000);
      await until(() => expect(result.current.data?.status).toBe("processing"));
      await vi.advanceTimersByTimeAsync(3_000);
      await until(() => expect(result.current.data?.status).toBe(last));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(asked()).toBe(3);
      unmount();
      vi.useRealTimers();
    }
  });
});
