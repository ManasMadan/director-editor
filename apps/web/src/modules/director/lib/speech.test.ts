import { describe, expect, it } from "vitest";
import { voiceFor } from "./speech";

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
});
