import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { hush, say } from "@/modules/director/lib/speech";

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
    expect(said()).toEqual([["Step back a little", "en-GB", 1.05]]);
  });

  it("doesn't repeat itself until something else has been said", () => {
    say("Hold still", "en");
    say("Hold still", "en");
    expect(said()).toEqual([["Hold still", "en", 1.05]]);
    say("Now smile", "en");
    say("Hold still", "en");
    expect(said().map(([text]) => text)).toEqual(["Hold still", "Now smile", "Hold still"]);
  });

  it("can let the current line finish", () => {
    say("Ready", "en", { interrupt: false });
    expect(cancel).not.toHaveBeenCalled();
    expect(said()).toEqual([["Ready", "en", 1.05]]);
  });

  it("goes quiet, and may then say the same line again", () => {
    say("Action", "en");
    hush();
    expect(cancel).toHaveBeenCalledTimes(2);
    say("Action", "en");
    expect(said().map(([text]) => text)).toEqual(["Action", "Action"]);
  });
});
