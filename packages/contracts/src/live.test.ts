/** Director live's messages: one schema for what the browser sends and what it hears back. */
import { describe, expect, it } from "vitest";
import { DIRECTOR_MAX_SHOTS } from "./api/director";
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
    expect(liveClientMessage.parse({ type: "take", state: "recorded" })).toEqual({
      type: "take",
      state: "recorded",
    });
    expect(liveClientMessage.safeParse({ type: "take", state: "say something" }).success).toBe(
      false,
    );
    expect(liveClientMessage.safeParse({ type: "camera", facing: "sideways" }).success).toBe(false);
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
