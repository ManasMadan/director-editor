import { afterEach, describe, expect, it, vi } from "vitest";
import { hush, say, voiceFor } from "./speech";

afterEach(() => {
  vi.unstubAllGlobals();
});

const voice = (name: string, lang: string) => ({ name, lang });

describe("Director's voice", () => {
  it("picks the most natural voice for the language", () => {
    const voices = [
      voice("Fred", "en-US"),
      voice("Google US English", "en-US"),
      voice("Ava (Premium)", "en-US"),
      voice("Mónica", "es-ES"),
    ];
    expect(voiceFor(voices, "en")?.name).toBe("Ava (Premium)");
    expect(voiceFor(voices, "es-MX")?.name).toBe("Mónica");
    expect(voiceFor(voices, "fr")).toBeNull();
  });

  it("says nothing on the server, or in a browser without speech synthesis", () => {
    const utterance = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", utterance);
    say("Step back", "en");
    hush();
    vi.stubGlobal("window", {});
    say("Step back", "en");
    hush();
    expect(utterance).not.toHaveBeenCalled();
  });
});
