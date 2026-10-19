import { describe, expect, it } from "vitest";
import { hasVoice, ToolRepeats } from "./live.guards";

const pcm = (level: number) =>
  Buffer.from(
    new Int16Array(1600).map((_, at) => Math.round(Math.sin(at / 4) * level * 32_767)).buffer,
  ).toString("base64");

describe("the relay's guards", () => {
  it("hear a voice on the microphone, not a quiet room or nothing at all", () => {
    expect(hasVoice(pcm(0.2))).toBe(true);
    expect(hasVoice(pcm(0.002))).toBe(false);
    expect(hasVoice("")).toBe(false);
  });

  it("let each tool through five times in ten seconds, each counted on its own", () => {
    const clock = { now: 0 };
    const repeats = new ToolRepeats(() => clock.now);
    for (let call = 0; call < 5; call += 1) {
      expect(repeats.allows("mark")).toBe(true);
    }
    expect(repeats.allows("mark")).toBe(false);
    expect(repeats.allows("remember")).toBe(true);
    clock.now = 10_000;
    expect(repeats.allows("mark")).toBe(true);
  });
});
