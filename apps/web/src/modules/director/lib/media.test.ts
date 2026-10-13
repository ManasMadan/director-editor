import { describe, expect, it } from "vitest";
import { recorderFormat } from "./media";

describe("the recorder's format", () => {
  it("prefers MP4 (Safari, recent Chromium), then WebM", () => {
    expect(recorderFormat((type) => type.startsWith("video/mp4"))).toEqual({
      mimeType: "video/mp4;codecs=avc1,mp4a.40.2",
      uploadType: "video/mp4",
    });
    expect(recorderFormat((type) => type === "video/webm;codecs=vp8,opus")).toEqual({
      mimeType: "video/webm;codecs=vp8,opus",
      uploadType: "video/webm",
    });
  });

  it("is none where the browser records nothing", () => {
    expect(recorderFormat(() => false)).toBeNull();
  });
});
