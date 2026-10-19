/** A link to read one of the member's files, asked for once per file. */
import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { useDownloadUrl } from "@/modules/director/hooks/use-download-url";
import { deferred, renderHook, standIn } from "./support";

const FIRST = crypto.randomUUID();
const SECOND = crypto.randomUUID();

describe("a file's download link", () => {
  it("is the file now on screen's, not one asked for before that answered late", async () => {
    const late = deferred<{ url: string; expiresAt: Date }>();
    const api = standIn((os) => ({
      files: {
        downloadUrl: os.files.downloadUrl.handler(({ input }) =>
          input.fileId === FIRST
            ? late.promise
            : { url: "https://storage.test/second", expiresAt: new Date(Date.now() + 60_000) },
        ),
      },
    }));
    let fileId = FIRST;
    const hook = await renderHook(() => useDownloadUrl(fileId), { api });
    expect(hook.current).toBeUndefined();
    fileId = SECOND;
    hook.rerender();
    await expect.poll(() => hook.current).toBe("https://storage.test/second");
    late.resolve({ url: "https://storage.test/first", expiresAt: new Date(Date.now() + 60_000) });
    await late.promise;
    await expect.poll(() => api.calls.length).toBe(2);
    expect(hook.current).toBe("https://storage.test/second");
  });

  it("is none for a file it can't have, and a refusal that lands late changes nothing", async () => {
    const late = deferred<{ url: string; expiresAt: Date }>();
    const api = standIn((os) => ({
      files: {
        downloadUrl: os.files.downloadUrl.handler(({ input }) => {
          if (input.fileId === FIRST) {
            return late.promise;
          }
          throw new ORPCError("FILE_NOT_FOUND");
        }),
      },
    }));
    let fileId = FIRST;
    const hook = await renderHook(() => useDownloadUrl(fileId), { api });
    fileId = SECOND;
    hook.rerender();
    await expect.poll(() => hook.current).toBeNull();
    late.reject(new ORPCError("FILE_NOT_FOUND"));
    await late.promise.catch(() => undefined);
    expect(hook.current).toBeNull();
  });
});
