import type { ShotPlan } from "@repo/contracts/api";
import { describe, expect, it } from "vitest";
import { defaultAudio, offersVoice, parseAudio } from "./audio";

const plan = (audio: ShotPlan["audio"]): ShotPlan => ({
  title: "t",
  format: "f",
  summary: "s",
  audio,
  durationSeconds: 1,
  shots: [],
  assets: [],
  edits: [],
});

describe("the audio choice", () => {
  it("is offered only for a short with speech", () => {
    expect(offersVoice(plan("speech"))).toBe(true);
    expect(offersVoice(plan("speech-and-music"))).toBe(true);
    expect(offersVoice(plan("music"))).toBe(false);
    expect(defaultAudio(plan("speech"))).toBe("voice");
    expect(defaultAudio(plan("none"))).toBe("original");
  });

  it("reads the choice from the address, falling back to the plan's default", () => {
    expect(parseAudio("original", plan("speech"))).toBe("original");
    expect(parseAudio("voice", plan("speech"))).toBe("voice");
    expect(parseAudio("voice", plan("music"))).toBe("original");
    expect(parseAudio("loud", plan("speech"))).toBe("voice");
    expect(parseAudio(undefined, plan("music"))).toBe("original");
  });
});
