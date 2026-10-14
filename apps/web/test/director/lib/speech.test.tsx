import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { hush, onSaying, say, saying } from "@/modules/director/lib/speech";

let speak: MockInstance<SpeechSynthesis["speak"]>;
let cancel: MockInstance<SpeechSynthesis["cancel"]>;

beforeEach(() => {
  // The browser's voice, kept quiet: each utterance it's given is checked instead.
  speak = vi.spyOn(window.speechSynthesis, "speak").mockReturnValue(undefined);
  cancel = vi.spyOn(window.speechSynthesis, "cancel").mockReturnValue(undefined);
  hush();
  cancel.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const said = () =>
  speak.mock.calls.map(([utterance]) => [
    utterance.text,
    utterance.lang,
    // Kept in single precision.
    Math.round(utterance.rate * 100) / 100,
  ]);

describe("Director's voice", () => {
  it("reads a line out in the page's language, over whatever it was saying", () => {
    say("Step back a little", "en-GB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(said()).toEqual([["Step back a little", "en-GB", 1.06]]);
  });

  it("doesn't repeat itself until something else has been said", () => {
    say("Hold still", "en");
    say("Hold still", "en");
    expect(said()).toEqual([["Hold still", "en", 1.06]]);
    say("Now smile", "en");
    say("Hold still", "en");
    expect(said().map(([text]) => text)).toEqual(["Hold still", "Now smile", "Hold still"]);
  });

  it("reads in the most natural voice the device has for the language", () => {
    const voices = speechSynthesis.getVoices();
    vi.spyOn(window.speechSynthesis, "getVoices").mockReturnValue(voices);
    say("Lights", "en");
    const [utterance] = speak.mock.calls.map(([each]) => each);
    const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
    expect(utterance?.voice ?? null).toBe(english.length > 0 ? utterance?.voice : null);
    // Upbeat: a touch brighter than the default.
    expect(utterance?.pitch).toBeCloseTo(1.05);
  });

  it("says what it's saying while it says it, for the glow and the echo filter", () => {
    const changes = vi.fn();
    const stop = onSaying(changes);
    say("Camera rolling", "en");
    const [utterance] = speak.mock.calls.map(([each]) => each);
    expect(saying()).toBeNull();
    utterance?.onstart?.(new SpeechSynthesisEvent("start", { utterance }));
    expect(saying()).toBe("Camera rolling");
    // A newer line that began first keeps its place when this one ends.
    utterance?.onend?.(new SpeechSynthesisEvent("end", { utterance }));
    expect(saying()).toBeNull();
    utterance?.onstart?.(new SpeechSynthesisEvent("start", { utterance }));
    utterance?.onerror?.(
      new SpeechSynthesisErrorEvent("error", { utterance, error: "interrupted" }),
    );
    expect(saying()).toBeNull();
    expect(changes).toHaveBeenCalled();
    stop();
    changes.mockClear();
    hush();
    expect(changes).not.toHaveBeenCalled();
  });

  it("keeps a newer line as what it's saying when an older one ends", () => {
    say("One", "en");
    say("Two", "en");
    const [first, second] = speak.mock.calls.map(([each]) => each);
    second?.onstart?.(new SpeechSynthesisEvent("start", { utterance: second }));
    first?.onend?.(new SpeechSynthesisEvent("end", { utterance: first }));
    expect(saying()).toBe("Two");
  });

  it("goes quiet, and may then say the same line again", () => {
    say("Action", "en");
    hush();
    expect(cancel).toHaveBeenCalledTimes(2);
    say("Action", "en");
    expect(said().map(([text]) => text)).toEqual(["Action", "Action"]);
  });
});
