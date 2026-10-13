import { afterEach, describe, expect, it, vi } from "vitest";
import { hush, say } from "./speech";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Director's voice without the Web Speech API", () => {
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
