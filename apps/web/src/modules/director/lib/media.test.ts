import { describe, expect, it } from "vitest";
import { base64Of, recorderFormat } from "./media";

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

describe("a blob as base64", () => {
  it("encodes every byte, past the size read in one go", async () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, at) => (at * 7) % 256);
    expect(await base64Of(new Blob([bytes]))).toBe(Buffer.from(bytes).toString("base64"));
    expect(await base64Of(new Blob([]))).toBe("");
  });
});
