import { describe, expect, it } from "vitest";
import { TurnMeter } from "./live.turns";

function meter() {
  const clock = { now: 0 };
  return { clock, turns: new TurnMeter(() => clock.now) };
}

describe("a turn's figures", () => {
  it("time the member's wait from the last thing heard to Director's first audio", () => {
    const { clock, turns } = meter();
    turns.member("voice");
    clock.now = 400;
    turns.member("voice");
    clock.now = 1_300;
    turns.spoke(4800);
    clock.now = 1_500;
    turns.spoke(4800);
    // Heard after Director started: it's the next turn's, not this one's wait.
    turns.member("voice");
    expect(turns.complete()).toEqual({
      input: "voice",
      latencyMs: 900,
      tools: [],
      interrupted: false,
      spoke: true,
      voiceMs: 200,
      captionLagMs: null,
    });
  });

  it("time how far the turn's first words trail its first audio", () => {
    const { clock, turns } = meter();
    clock.now = 100;
    turns.spoke(48_000);
    clock.now = 700;
    turns.said();
    clock.now = 900;
    turns.said();
    expect(turns.complete()).toMatchObject({ voiceMs: 1000, captionLagMs: 600 });
    // Words before the voice: the captions are early, not late.
    turns.said();
    clock.now = 1000;
    turns.spoke(48);
    expect(turns.complete()).toMatchObject({ voiceMs: 1, captionLagMs: -100 });
  });

  it("keep the tools in order, a cut-in, and start clean after each turn", () => {
    const { clock, turns } = meter();
    turns.member("text");
    turns.tool("adapt_shot");
    turns.tool("rate");
    turns.tool("go_to_shot");
    turns.cutIn();
    expect(turns.complete()).toEqual({
      input: "text",
      latencyMs: null,
      tools: ["adapt_shot", "rate", "go_to_shot"],
      interrupted: true,
      spoke: false,
      voiceMs: 0,
      captionLagMs: null,
    });
    // A turn the app's note started (a flip, a take): nobody waited on it.
    clock.now = 50;
    turns.spoke(96);
    expect(turns.complete()).toEqual({
      input: "app",
      latencyMs: null,
      tools: [],
      interrupted: false,
      spoke: true,
      voiceMs: 2,
      captionLagMs: null,
    });
  });
});
