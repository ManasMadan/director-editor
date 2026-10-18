import { describe, expect, it } from "vitest";
import { logTurnTiming, turnTimings } from "./live-debug";

const timing = { textAfterAudioMs: 400, queuedAheadMs: 0, heldMs: 0, voiceMs: 1200 };

describe("the live debug log", () => {
  it("keeps the last fifty turns' timing, oldest first, and no more", () => {
    for (let turn = 0; turn < 55; turn += 1) {
      logTurnTiming({ ...timing, voiceMs: turn }, turn);
    }
    const kept = turnTimings();
    expect(kept).toHaveLength(50);
    expect(kept[0]).toEqual({ ...timing, voiceMs: 5, at: 5 });
    expect(kept.at(-1)?.at).toBe(54);
  });
});
