/**
 * Dictation with the browser's own speech recogniser (here one the test speaks into):
 * each finished phrase is said, nothing while paused, started again after the browser
 * stops it, and given up on where it's refused or missing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "@/modules/director/hooks/use-dictation";
import { canDictate, startDictation } from "@/modules/director/lib/dictation";
import { FakeRecognizer, fakeRecognizer, renderHook } from "../support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The recogniser the dictation made, which the test speaks into. */
function recognizer() {
  const made = FakeRecognizer.last;
  if (!made) {
    throw new Error("no recogniser was made");
  }
  return made;
}

function dictating() {
  const said: string[] = [];
  const onDeaf = vi.fn();
  const dictation = startDictation({ onSaid: (text) => said.push(text), onDeaf });
  return { said, onDeaf, dictation, recognizer: recognizer() };
}

describe("dictation", () => {
  it("can't start in a browser with no recogniser, and says so once", () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    expect(canDictate()).toBe(false);
    const onDeaf = vi.fn();
    expect(startDictation({ onSaid: () => undefined, onDeaf })).toBeNull();
    expect(onDeaf).toHaveBeenCalledOnce();
  });

  it("uses the unprefixed recogniser where the browser has one", () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognizer);
    expect(canDictate()).toBe(true);
    const { recognizer: made } = dictating();
    expect(made.started).toBe(1);
    expect(made.continuous).toBe(true);
    expect(made.lang).toBe(navigator.language);
  });

  it("says each finished phrase, and nothing still being heard, empty or said while paused", () => {
    fakeRecognizer();
    const { said, dictation, recognizer: made } = dictating();
    made.hear("still talk", { final: false });
    made.hear("   ");
    made.hear(" By the window ");
    dictation?.pause(true);
    made.hear("Director's own voice");
    expect(said).toEqual(["By the window"]);
  });

  it("starts again at once when the browser stops listening, and after a breath when it failed", () => {
    fakeRecognizer();
    vi.useFakeTimers();
    const { recognizer: made } = dictating();
    made.stop();
    vi.advanceTimersByTime(0);
    expect(made.started).toBe(2);
    // Nothing heard, or the network: tried again a second later.
    made.fail("no-speech");
    made.stop();
    vi.advanceTimersByTime(999);
    expect(made.started).toBe(2);
    vi.advanceTimersByTime(1);
    expect(made.started).toBe(3);
  });

  it("gives up for good when the microphone is refused", () => {
    fakeRecognizer();
    vi.useFakeTimers();
    const { onDeaf, recognizer: made } = dictating();
    made.fail("not-allowed");
    expect(onDeaf).toHaveBeenCalledOnce();
    // Its end would start it again: refused, it doesn't.
    made.stop();
    vi.runAllTimers();
    expect(made.started).toBe(1);
  });

  it("pauses while Director speaks, and listens again after", () => {
    fakeRecognizer();
    vi.useFakeTimers();
    const { dictation, recognizer: made } = dictating();
    dictation?.pause(true);
    // The browser's end of listening, while paused: not started again.
    vi.runAllTimers();
    expect(made.started).toBe(1);
    dictation?.pause(false);
    expect(made.started).toBe(2);
    // Already listening: resuming again doesn't start it twice.
    dictation?.pause(false);
    expect(made.started).toBe(2);
    dictation?.stop();
    expect(made.onend).toBeNull();
  });

  it("waits for its own end when the browser is still starting it", () => {
    class Starting extends FakeRecognizer {
      override start() {
        super.start();
        if (this.started === 1) {
          throw new DOMException("recognition has already started", "InvalidStateError");
        }
      }
    }
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", Starting);
    vi.useFakeTimers();
    const { recognizer: made } = dictating();
    expect(made.started).toBe(1);
    made.stop();
    vi.runAllTimers();
    expect(made.started).toBe(2);
  });
});

describe("the mic button's dictation", () => {
  it("listens from a tap until the next, and isn't offered once it's refused", async () => {
    fakeRecognizer();
    const phrases: string[] = [];
    const hook = await renderHook(() => useDictation((text) => phrases.push(text)));
    await expect.poll(() => hook.current.supported).toBe(true);
    hook.current.start();
    await expect.poll(() => hook.current.listening).toBe(true);
    // A second start while listening is the same dictation.
    const made = recognizer();
    hook.current.start();
    expect(FakeRecognizer.last).toBe(made);
    made.hear("My morning coffee");
    expect(phrases).toEqual(["My morning coffee"]);
    made.fail("audio-capture");
    await expect.poll(() => hook.current.supported).toBe(false);
    expect(hook.current.listening).toBe(false);
  });
});
