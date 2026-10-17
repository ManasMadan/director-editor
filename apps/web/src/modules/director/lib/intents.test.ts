import en from "@repo/i18n/messages/en.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { intentOf, isClear, isEcho, normalize, type Vocabulary } from "./intents";

const english: Vocabulary = en.director.live.voice.words;

describe("talking to Director", () => {
  it("reads what each phrase asks for", () => {
    expect(intentOf("Action!", english)).toBe("action");
    expect(intentOf("okay let's go", english)).toBe("action");
    expect(intentOf("cut", english)).toBe("cut");
    expect(intentOf("can we flip the camera", english)).toBe("flip");
    expect(intentOf("keep it", english)).toBe("keep");
    expect(intentOf("what did you say", english)).toBe("repeat");
    expect(intentOf("the weather is nice", english)).toBeNull();
  });

  it("takes the longest phrase, so 'go again' is a retake", () => {
    expect(intentOf("go again", english)).toBe("again");
  });

  it("matches whole words only", () => {
    expect(intentOf("cutlery", english)).toBeNull();
  });

  it("hears a phrase whatever its accents, case and spacing", () => {
    expect(normalize("  ¿Dónde   estoy? ")).toBe("donde estoy");
    expect(intentOf("ACTION!", english)).toBe("action");
  });

  it("knows Director's own voice when the microphone hears it", () => {
    expect(isEcho("say action when you're ready", "Say action when you're ready!")).toBe(true);
    expect(isEcho("wait, flip it", "Say action when you're ready!")).toBe(false);
    expect(isEcho("anything", null)).toBe(false);
    expect(isEcho("...", "Hello")).toBe(true);
  });

  it("ignores noise and guesses the recogniser doubts", () => {
    expect(isClear("cut", 0.9)).toBe(true);
    expect(isClear("cut", 0)).toBe(true);
    expect(isClear("cut", 0.1)).toBe(false);
    expect(isClear("a", 0.9)).toBe(false);
  });
});
