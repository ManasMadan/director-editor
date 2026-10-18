/** What publishing makes of YouTube's refusals, and of its being down. */

import { AppError } from "@repo/nest-common";
import { describe, expect, it } from "vitest";
import { noCreditWhileYouTubeIsDown, publishErrorOf } from "./publish.service";
import { YouTubeUploadError } from "./youtube-upload";

describe("a failed upload", () => {
  const codeOf = (error: unknown) => (error instanceof AppError ? error.code : error);

  it("is the member's to fix when YouTube says so", () => {
    expect(codeOf(publishErrorOf(new YouTubeUploadError(401, "youtubeSignupRequired")))).toBe(
      "PUBLISH_NO_CHANNEL",
    );
    expect(codeOf(publishErrorOf(new YouTubeUploadError(401, "authError")))).toBe(
      "PUBLISH_NEEDS_YOUTUBE",
    );
    expect(codeOf(publishErrorOf(new YouTubeUploadError(403, "insufficientPermissions")))).toBe(
      "PUBLISH_NEEDS_YOUTUBE",
    );
  });

  it("is today's allowance used up when YouTube says the quota or its rate is spent", () => {
    for (const reason of [
      "quotaExceeded",
      "dailyLimitExceeded",
      "uploadLimitExceeded",
      "rateLimitExceeded",
    ]) {
      expect(codeOf(publishErrorOf(new YouTubeUploadError(403, reason))), reason).toBe(
        "PUBLISH_QUOTA_EXHAUSTED",
      );
    }
  });

  it("is YouTube being unavailable otherwise, and anything else stays as it is", () => {
    const outage = publishErrorOf(new YouTubeUploadError(503, "backendError"));
    expect(outage).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", params: { service: "youtube" } });
    const bug = new Error("a bug");
    expect(publishErrorOf(bug)).toBe(bug);
  });
});

describe("the original's credit for the post", () => {
  it("is left out while YouTube can't be read, and any other failure stays one", () => {
    const outage = new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "youtube" } });
    expect(noCreditWhileYouTubeIsDown(outage)).toBeNull();
    const off = new AppError("FEATURE_DISABLED", { params: { feature: "director" } });
    expect(() => noCreditWhileYouTubeIsDown(off)).toThrow(off);
    const bug = new Error("a bug");
    expect(() => noCreditWhileYouTubeIsDown(bug)).toThrow(bug);
  });
});
