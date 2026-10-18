import { ORPCError } from "@orpc/client";
import type { MatchCutAlignment, MatchCutAsk } from "@repo/contracts/api";
import { directorTakeIdSchema, videoIdSchema } from "@repo/contracts/ids";
import { describe, expect, it } from "vitest";
import { id, renderHook, standIn, until } from "../../../test/stand-in";
import { useMatchCutAlignments } from "./match-cuts";

const ask = (anchor: string): MatchCutAsk => ({
  videoId: videoIdSchema.parse("dQw4w9WgXcQ"),
  anchor,
  outgoing: { takeId: directorTakeIdSchema.parse(id(1)), atMs: 1500 },
  incoming: { takeId: directorTakeIdSchema.parse(id(2)), atMs: 0 },
});

const aligned: MatchCutAlignment = {
  status: "aligned",
  outgoingEndMs: 1433,
  incomingStartMs: 66,
  transform: { x: -40, y: 12, scale: 0.97, rotation: -1.5 },
  offsetBeforePx: 61,
  offsetPx: 2.1,
  scaleDiff: 0.01,
  rotationDiff: 0.2,
  cropPercent: 6,
  withinTolerance: true,
  anchor: { x: 0.5, y: 0.4 },
  outgoingFrame: null,
  incomingFrame: null,
};

describe("useMatchCutAlignments", () => {
  it("lines up each match cut once, and keeps a failure as a failure", async () => {
    const sent: MatchCutAsk[] = [];
    const api = standIn((os) => ({
      director: {
        alignMatchCut: os.director.alignMatchCut.handler(({ input }) => {
          sent.push(input);
          if (input.anchor === "the ring") {
            throw new ORPCError("UPSTREAM_UNAVAILABLE");
          }
          return aligned;
        }),
      },
    }));
    const asks = [ask("the watch"), ask("the ring")];
    const { result } = renderHook(() => useMatchCutAlignments(asks), api);
    await until(() => {
      expect(result.current[0]?.data).toEqual(aligned);
      expect(result.current[1]?.isError).toBe(true);
    });
    // Not retried, and not asked again while the answer is kept.
    expect(sent.map((input) => input.anchor)).toEqual(["the watch", "the ring"]);
  });
});
