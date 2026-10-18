import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { userEvent } from "vitest/browser";
import { hush, onSaying, say, saying } from "@/modules/director/lib/speech";
import { silentWav } from "../support";

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

describe("Director's own voice (Gemini's)", () => {
  // The browser plays sound only once the member has touched the page, as they have by the
  // time Director talks on the shoot screen.
  beforeAll(() => userEvent.click(document.body));

  it("plays the line in it instead of the browser's, saying what it's saying meanwhile", async () => {
    const voice = vi.fn(async (_text: string) => silentWav(1));
    const heard: (string | null)[] = [];
    const stop = onSaying(() => heard.push(saying()));
    say("Take a step back", "en", voice);
    expect(voice).toHaveBeenCalledWith("Take a step back");
    await expect.poll(() => heard).toEqual(["Take a step back", null]);
    stop();
    expect(speak).not.toHaveBeenCalled();
  });

  it("says it in the browser's voice when Director's can't be had", async () => {
    say("Find some light", "en", () => Promise.reject(new Error("upstream")));
    await expect.poll(() => said().map(([text]) => text)).toEqual(["Find some light"]);
  });

  it("says it in the browser's voice when Director's can't be played", async () => {
    say("Smile", "en", async () => URL.createObjectURL(new Blob(["not audio"])));
    await expect.poll(() => said().map(([text]) => text)).toEqual(["Smile"]);
  });

  it("doesn't keep the member waiting: a line slow to come is said in the browser's voice", async () => {
    const late = Promise.withResolvers<string>();
    say("Hold it there", "en", () => late.promise);
    await expect
      .poll(() => said().map(([text]) => text), { timeout: 5_000 })
      .toEqual(["Hold it there"]);
    // When it comes after all, it isn't said a second time.
    late.resolve(silentWav(0.2));
    await late.promise;
    expect(saying()).toBeNull();
  });

  it("drops a line still on its way once another has been said, or Director goes quiet", async () => {
    const first = Promise.withResolvers<string>();
    say("One", "en", () => first.promise);
    say("Two", "en");
    first.resolve(silentWav(0.2));
    await first.promise;
    const second = Promise.withResolvers<string>();
    say("Three", "en", () => second.promise);
    hush();
    second.resolve(silentWav(0.2));
    await second.promise;
    expect(said().map(([text]) => text)).toEqual(["Two"]);
    expect(saying()).toBeNull();
  });

  it("says nothing of a line cut off as it starts to play, in either voice", async () => {
    const link = Promise.resolve(silentWav(1));
    const heard: (string | null)[] = [];
    const stop = onSaying(() => heard.push(saying()));
    say("Wait for it", "en", () => link);
    // The line's own handler runs first: it is playing (not yet started) when hushed.
    await link;
    hush();
    const after = Promise.withResolvers<string>();
    say("Next", "en", () => after.promise);
    after.reject(new Error("upstream"));
    await expect.poll(() => said().map(([text]) => text)).toEqual(["Next"]);
    stop();
    expect(heard).not.toContain("Wait for it");
  });

  it.each(["error", "abort"])(
    "stops saying a line whose sound breaks off midway (%s), and says it no other way",
    async (event) => {
      const play = vi.spyOn(HTMLMediaElement.prototype, "play");
      say("Keep going", "en", async () => silentWav(3));
      await expect.poll(saying).toBe("Keep going");
      const [line] = play.mock.contexts.filter((media) => media instanceof HTMLMediaElement);
      line?.dispatchEvent(new Event(event));
      expect(saying()).toBeNull();
      expect(speak).not.toHaveBeenCalled();
      // Gone quiet, it says the next line as usual.
      say("Now turn", "en", async () => silentWav(0.5));
      await expect.poll(saying).toBe("Now turn");
    },
  );

  it("stops playing when Director goes quiet", async () => {
    say("Keep going", "en", async () => silentWav(3));
    await expect.poll(saying).toBe("Keep going");
    hush();
    expect(saying()).toBeNull();
    say("Keep going", "en", async () => silentWav(0.2));
    await expect.poll(saying).toBe("Keep going");
  });
});
