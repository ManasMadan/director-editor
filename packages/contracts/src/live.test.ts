/** The live call's messages: one schema for what the browser sends and what it hears back. */
import { describe, expect, it } from "vitest";
import { DIRECTOR_MAX_SHOTS } from "./api/director";
import { liveClientMessage, liveServerMessage } from "./live";

describe("what the browser sends", () => {
  it("moves the call to a shot the plan can have, and nothing past it", () => {
    expect(liveClientMessage.parse({ type: "shot", shot: 3 })).toEqual({ type: "shot", shot: 3 });
    for (const shot of [-1, 1.5, DIRECTOR_MAX_SHOTS]) {
      expect(liveClientMessage.safeParse({ type: "shot", shot }).success).toBe(false);
    }
  });

  it("refuses an empty line and audio that isn't base64", () => {
    expect(liveClientMessage.safeParse({ type: "text", text: "  " }).success).toBe(false);
    expect(liveClientMessage.safeParse({ type: "audio", pcm16: "%%%%" }).success).toBe(false);
  });
});

describe("what the browser hears", () => {
  it("reads an error code newer than itself as our own failure", () => {
    expect(liveServerMessage.parse({ type: "error", code: "SOMETHING_NEW" })).toEqual({
      type: "error",
      code: "INTERNAL",
    });
  });

  it("knows only the five tools", () => {
    const tool = (name: string) => ({ type: "tool", name, args: {} });
    expect(liveServerMessage.safeParse(tool("retake")).success).toBe(true);
    expect(liveServerMessage.safeParse(tool("delete_everything")).success).toBe(false);
  });
});
