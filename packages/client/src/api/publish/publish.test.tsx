import { ORPCError } from "@orpc/client";
import type { DirectorCut } from "@repo/contracts/api";
import {
  directorCutIdSchema,
  directorPlanIdSchema,
  fileIdSchema,
  videoIdSchema,
} from "@repo/contracts/ids";
import { useQuery } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { errorCode } from "../../errors";
import { useApi } from "../../provider";
import { usePublishCopyMutation } from "./copy";
import { usePublishMutation } from "./upload";

const cutId = directorCutIdSchema.parse(id(1));
const copy = { title: "My look", description: "Mine.", hashtags: ["grwm"], credits: "By Maya." };
const cut = (publish: DirectorCut["publish"]): DirectorCut => ({
  id: cutId,
  planId: directorPlanIdSchema.parse(id(2)),
  videoId: videoIdSchema.parse("dQw4w9WgXcQ"),
  templateTitle: "Get ready with me",
  title: "My look",
  picks: {},
  fileId: fileIdSchema.parse(id(3)),
  durationMs: 4000,
  createdAt: new Date(0),
  publish,
});

describe("the YouTube post", () => {
  it("is Gemini's draft for the cut", async () => {
    const api = standIn((os) => ({ publish: { copy: os.publish.copy.handler(() => copy) } }));
    const { result } = renderHook(() => usePublishCopyMutation(), api);
    await expect(result.current.mutateAsync({ cutId })).resolves.toEqual(copy);
  });
});

describe("publishing", () => {
  it("answers with the cut as YouTube took it, and refreshes My media", async () => {
    let media = [cut({ status: "none", youtubeVideoId: null, visibility: null })];
    const published = cut({
      status: "published",
      youtubeVideoId: "AbCdEfGhIjK",
      visibility: "private",
    });
    const api = standIn((os) => ({
      director: { media: os.director.media.handler(() => media) },
      publish: {
        upload: os.publish.upload.handler(() => {
          media = [published];
          return published;
        }),
      },
    }));
    // My media, as its own hook reads it.
    const useMedia = () => useQuery(useApi().api.director.media.queryOptions());
    const { result } = renderHook(
      () => ({ media: useMedia(), publish: usePublishMutation() }),
      api,
    );
    await until(() => expect(result.current.media.data).toHaveLength(1));
    await expect(
      result.current.publish.mutateAsync({ cutId, ...copy, visibility: "public" }),
    ).resolves.toEqual(published);
    await until(() => expect(result.current.media.data?.[0]?.publish.status).toBe("published"));
  });

  it("says when YouTube needs allowing first", async () => {
    const api = standIn((os) => ({
      publish: {
        upload: os.publish.upload.handler(() => {
          throw new ORPCError("PUBLISH_NEEDS_YOUTUBE");
        }),
      },
    }));
    const { result } = renderHook(() => usePublishMutation(), api);
    const error = await result.current
      .mutateAsync({ cutId, ...copy, visibility: "unlisted" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("PUBLISH_NEEDS_YOUTUBE");
  });
});
