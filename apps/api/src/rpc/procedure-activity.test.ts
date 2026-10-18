import { ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RecordActivity } from "../activity";
import { procedureActivity, procedureTarget } from "./procedure-activity";

/** A clock that moves 40ms each time it's read. */
function clock() {
  let now = 0;
  return () => {
    now += 40;
    return now;
  };
}

describe("a procedure call's activity line", () => {
  it("names a Director call for what it means, with the take it made", async () => {
    const record = vi.fn<RecordActivity>();
    const take = { id: "t-1", status: "pending", score: null, feedback: "x" };
    const answer = await procedureActivity(
      record,
      clock(),
    )({
      next: async () => take,
      path: ["director", "addTake"],
      input: { videoId: "v1", shotIndex: 2, kind: "video", fileId: "f-1" },
    });
    expect(answer).toBe(take);
    expect(record).toHaveBeenCalledWith({
      activity: "director.take_recorded",
      target: {
        procedure: "director.addTake",
        videoId: "v1",
        shotIndex: 2,
        kind: "video",
        fileId: "f-1",
        status: "pending",
        resultId: "t-1",
      },
      durationMs: 40,
    });
  });

  it("is api.called for any other procedure, with how many items a list answered", async () => {
    const record = vi.fn<RecordActivity>();
    await procedureActivity(
      record,
      clock(),
    )({
      next: async () => [{}, {}, {}],
      path: ["director", "takes"],
      input: { videoId: "v1" },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: "api.called",
        target: { procedure: "director.takes", videoId: "v1", count: 3 },
      }),
    );
  });

  it("says why a call was refused or failed, and passes the error on", async () => {
    const record = vi.fn<RecordActivity>();
    const refused = new ORPCError("PUBLISH_DEMO_DISABLED", { status: 403 });
    const call = procedureActivity(
      record,
      clock(),
    )({
      next: () => Promise.reject(refused),
      path: ["publish", "upload"],
      input: { cutId: "c-1", visibility: "public", title: "My short" },
    });
    await expect(call).rejects.toBe(refused);
    expect(record).toHaveBeenCalledWith({
      activity: "director.published",
      outcome: "refused",
      reason: "PUBLISH_DEMO_DISABLED",
      target: { procedure: "publish.upload", cutId: "c-1", visibility: "public" },
      durationMs: 40,
    });
  });

  it("keeps a publish's YouTube id and a scene check's verdict", () => {
    expect(
      procedureTarget(
        "publish.upload",
        { cutId: "c-1" },
        {
          id: "c-1",
          publish: { status: "published", youtubeVideoId: "yt-1" },
        },
      ),
    ).toEqual({
      procedure: "publish.upload",
      cutId: "c-1",
      resultId: "c-1",
      youtubeVideoId: "yt-1",
    });
    expect(
      procedureTarget(
        "director.checkScene",
        { videoId: "v1", shotIndex: 0, image: "data" },
        {
          inPlace: false,
          lighting: "too-dark",
          instruction: "Move left",
        },
      ),
    ).toEqual({
      procedure: "director.checkScene",
      videoId: "v1",
      shotIndex: 0,
      inPlace: false,
      lighting: "too-dark",
    });
  });

  it("never keeps what isn't on its list, nor a field of the wrong type", () => {
    expect(
      procedureTarget(
        "director.index",
        { url: "https://www.youtube.com/shorts/abc", videoId: 7 },
        "not an object",
      ),
    ).toEqual({ procedure: "director.index" });
    expect(procedureTarget("system.info", undefined, null)).toEqual({ procedure: "system.info" });
  });
});
