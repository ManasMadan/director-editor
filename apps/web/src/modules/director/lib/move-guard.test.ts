import { describe, expect, it } from "vitest";
import { AFTER_CHANGE_MS, createMoveGuard } from "./move-guard";

function guard() {
  const clock = { now: 0 };
  return { clock, moves: createMoveGuard(() => clock.now) };
}

describe("Director moving the member to another shot", () => {
  it("goes ahead when Director hasn't just changed the plan", () => {
    const { moves } = guard();
    expect(moves.allows()).toBe(true);
  });

  it("waits for the member's say-so for a while after a change", () => {
    const { clock, moves } = guard();
    moves.planChanged();
    // "ok perfect" after the change isn't asking to move on.
    moves.memberSaid("ok perfect");
    expect(moves.allows()).toBe(false);
    clock.now = AFTER_CHANGE_MS;
    expect(moves.allows()).toBe(true);
  });

  it("goes ahead when the member asked to move on since the change", () => {
    const { moves } = guard();
    moves.planChanged();
    moves.memberSaid("great, next one please");
    expect(moves.allows()).toBe(true);
    moves.planChanged();
    moves.memberSaid("Let's go to shot 3");
    expect(moves.allows()).toBe(true);
  });

  it("takes the member's answer once Director has been told to ask, in any words", () => {
    const { moves } = guard();
    moves.planChanged();
    expect(moves.allows()).toBe(false);
    expect(moves.allows()).toBe(false);
    moves.memberSaid("sí, vamos");
    expect(moves.allows()).toBe(true);
    // A new change starts over.
    moves.planChanged();
    expect(moves.allows()).toBe(false);
  });
});
