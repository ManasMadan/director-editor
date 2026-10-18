import { describe, expect, it } from "vitest";
import { turnTimings } from "./live-debug";
import { CHARS_PER_SECOND, createVoiceClock } from "./voice-clock";

function clock() {
  const audio = { now: 10 };
  return { audio, voice: createVoiceClock(() => audio.now) };
}

describe("when Director's voice plays", () => {
  it("places a turn's words along its queued voice, at an even pace", () => {
    const { audio, voice } = clock();
    // Two seconds of voice arrive at once, with the transcript's first words.
    voice.queued(1);
    voice.queued(1);
    expect(voice.leftMs()).toBe(2000);
    expect(voice.wait("Hi! ")).toBe(0);
    // These come after the first four characters, which take a moment to say.
    expect(voice.wait("Step back a little.")).toBeCloseTo((4 / CHARS_PER_SECOND) * 1000);
    // Words arriving after their moment show at once.
    audio.now = 12;
    expect(voice.wait(" Now.")).toBe(0);
    expect(voice.turnOver()).toEqual({
      textAfterAudioMs: 0,
      queuedAheadMs: 0,
      heldMs: Math.round((4 / CHARS_PER_SECOND) * 1000),
      voiceMs: 2000,
    });
  });

  it("shows words at once when there's no voice to wait for, and starts over once dropped", () => {
    const { audio, voice } = clock();
    expect(voice.wait("typed")).toBe(0);
    expect(voice.turnOver()).toEqual({
      textAfterAudioMs: null,
      queuedAheadMs: null,
      heldMs: 0,
      voiceMs: 0,
    });
    voice.queued(3);
    voice.flushed();
    expect(voice.leftMs()).toBe(0);
    audio.now = 11;
    voice.queued(1);
    expect(voice.wait("Again")).toBe(0);
  });

  it("keeps the last turns' timing for the debug log", () => {
    expect(Array.isArray(turnTimings())).toBe(true);
  });
});
