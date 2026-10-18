import type { DirectorCut } from "@repo/contracts/api";
import {
  directorCutIdSchema,
  directorPlanIdSchema,
  directorTakeIdSchema,
  fileIdSchema,
  videoIdSchema,
} from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { cutsByTemplate, templateThumbnail } from "./cuts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function cut(n: number, videoId: string, templateTitle: string): DirectorCut {
  return {
    id: directorCutIdSchema.parse(id(n)),
    planId: directorPlanIdSchema.parse(id(50)),
    videoId: videoIdSchema.parse(videoId),
    templateTitle,
    title: `Cut ${n}`,
    picks: { 0: directorTakeIdSchema.parse(id(60)) },
    fileId: fileIdSchema.parse(id(70 + n)),
    durationMs: 12_000,
    createdAt: new Date(n),
    publish: { status: "none", youtubeVideoId: null, visibility: null },
  };
}

describe("My media", () => {
  it("groups the cuts by the template they were made from, newest template first", () => {
    const [a3, b2, a1] = [
      cut(3, "aaaaaaaaaaa", "Morning"),
      cut(2, "bbbbbbbbbbb", "Dance"),
      cut(1, "aaaaaaaaaaa", "Morning"),
    ];
    expect(cutsByTemplate([a3, b2, a1])).toEqual([
      { videoId: "aaaaaaaaaaa", title: "Morning", cuts: [a3, a1] },
      { videoId: "bbbbbbbbbbb", title: "Dance", cuts: [b2] },
    ]);
    expect(cutsByTemplate([])).toEqual([]);
  });

  it("shows a template by its Short's YouTube thumbnail", () => {
    expect(templateThumbnail("dQw4w9WgXcQ")).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });
});
