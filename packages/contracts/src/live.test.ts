/** Director live's messages: one schema for what the browser sends and what it hears back. */
import { describe, expect, it } from "vitest";
import { DIRECTOR_MAX_SHOTS } from "./api/director";
import { EMPTY_VERSION, yourVersionSchema } from "./api/your-version";
import { liveClientMessage, liveServerMessage } from "./live";

describe("what the browser sends", () => {
  it("moves to a shot the plan can have, and nothing past it", () => {
    expect(liveClientMessage.parse({ type: "shot", shot: 3 })).toEqual({ type: "shot", shot: 3 });
    for (const shot of [-1, 1.5, DIRECTOR_MAX_SHOTS]) {
      expect(liveClientMessage.safeParse({ type: "shot", shot }).success).toBe(false);
    }
  });

  it("refuses an empty line and audio that isn't base64", () => {
    expect(liveClientMessage.safeParse({ type: "text", text: "  " }).success).toBe(false);
    expect(liveClientMessage.safeParse({ type: "audio", pcm16: "%%%%" }).success).toBe(false);
  });

  it("answers a tool call with one of the known results", () => {
    const answer = (result: string, id = "call-1") => ({ type: "tool_result", id, result });
    expect(liveClientMessage.parse(answer("busy"))).toEqual(answer("busy"));
    expect(liveClientMessage.safeParse(answer("whatever")).success).toBe(false);
    expect(liveClientMessage.safeParse(answer("done", "x".repeat(65))).success).toBe(false);
  });

  it("says what the member did, never in its own words", () => {
    expect(liveClientMessage.parse({ type: "camera", facing: "back" })).toEqual({
      type: "camera",
      facing: "back",
    });
    for (const state of ["countdown", "cancelled", "recording", "recorded", "discarded"]) {
      expect(liveClientMessage.parse({ type: "take", state })).toEqual({ type: "take", state });
    }
    expect(liveClientMessage.safeParse({ type: "take", state: "say something" }).success).toBe(
      false,
    );
    expect(liveClientMessage.safeParse({ type: "camera", facing: "sideways" }).success).toBe(false);
  });
});

describe("the member's version", () => {
  const version = (change: object) => ({ ...EMPTY_VERSION, shots: [change] });

  it("changes a shot's rows, each bounded, and travels back as context", () => {
    const adapted = { shot: 1, action: "Grandma does the nod, you react", camera: "back" };
    expect(liveClientMessage.parse({ type: "context", version: version(adapted) })).toEqual({
      type: "context",
      version: version(adapted),
    });
    const tool = { type: "tool", id: "1", call: { name: "adapt_shot", ...adapted } };
    expect(liveServerMessage.parse(tool)).toEqual(tool);
    for (const bad of [
      { shot: 0, line: "x".repeat(301) },
      { shot: 0, where: " " },
    ]) {
      expect(liveClientMessage.safeParse({ type: "context", version: version(bad) }).success).toBe(
        false,
      );
    }
  });

  it("remembers, forgets, skips, restores and re-plans, within bounds", () => {
    const calls = [
      { name: "remember", kind: "place", note: "Inside" },
      { name: "forget", note: "Inside" },
      { name: "skip_shot", shot: 2, why: "no market" },
      { name: "restore_shot", shot: 0 },
      { name: "replan", instruction: "one position, front camera" },
    ];
    for (const call of calls) {
      const tool = { type: "tool", id: "1", call };
      expect(liveServerMessage.parse(tool)).toEqual(tool);
    }
    const refused = [
      { name: "remember", kind: "mood", note: "Happy" },
      { name: "remember", kind: "place", note: "x".repeat(61) },
      { name: "replan", instruction: " " },
      { name: "skip_shot", shot: DIRECTOR_MAX_SHOTS },
    ];
    for (const call of refused) {
      expect(liveServerMessage.safeParse({ type: "tool", id: "1", call }).success).toBe(false);
    }
  });

  it("tells the relay of a chip taken away and a row put back", () => {
    const forgot = { type: "forgot", kind: "place", note: "Inside" };
    expect(liveClientMessage.parse(forgot)).toEqual(forgot);
    const restored = { type: "restored", shot: 1, row: "where" };
    expect(liveClientMessage.parse(restored)).toEqual(restored);
    expect(liveClientMessage.safeParse({ ...restored, row: "title" }).success).toBe(false);
  });

  it("keeps a version's skipped shots and gaps once each, in order", () => {
    expect(yourVersionSchema.parse({ ...EMPTY_VERSION, skipped: [3, 1, 3], gaps: [2, 2] })).toEqual(
      { ...EMPTY_VERSION, skipped: [1, 3], gaps: [2] },
    );
  });
});

describe("what the browser hears", () => {
  it("hears when Director's turn is over", () => {
    expect(liveServerMessage.parse({ type: "turn" })).toEqual({ type: "turn" });
  });

  it("reads an error code newer than itself as our own failure", () => {
    expect(liveServerMessage.parse({ type: "error", code: "SOMETHING_NEW" })).toEqual({
      type: "error",
      code: "INTERNAL",
    });
  });

  it("knows only the tools that can't start a take, each with its own arguments", () => {
    const tool = (call: object) => ({ type: "tool", id: "1", call });
    expect(liveServerMessage.safeParse(tool({ name: "go_to_shot", shot: 2 })).success).toBe(true);
    expect(liveServerMessage.safeParse(tool({ name: "switch_camera", to: "front" })).success).toBe(
      true,
    );
    expect(liveServerMessage.safeParse(tool({ name: "go_to_shot" })).success).toBe(false);
    expect(liveServerMessage.safeParse(tool({ name: "start_recording" })).success).toBe(false);
  });
});
