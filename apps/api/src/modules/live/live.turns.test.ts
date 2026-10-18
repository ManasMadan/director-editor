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
    turns.spoke();
    clock.now = 1_500;
    turns.spoke();
    // Heard after Director started: it's the next turn's, not this one's wait.
    turns.member("voice");
    expect(turns.complete()).toEqual({
      input: "voice",
      latencyMs: 900,
      tools: [],
      interrupted: false,
      spoke: true,
    });
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
    });
    // A turn the app's note started (a flip, a take): nobody waited on it.
    clock.now = 50;
    turns.spoke();
    expect(turns.complete()).toEqual({
      input: "app",
      latencyMs: null,
      tools: [],
      interrupted: false,
      spoke: true,
    });
  });
});
