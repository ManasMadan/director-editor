import { describe, expect, it } from "vitest";
import { liveUrl, NO_CAPTIONS, parseServerMessage, withTranscript } from "./live";

describe("Director live's address", () => {
  it("is the API's live route on the page's own origin, over TLS when the page is", () => {
    expect(liveUrl({ protocol: "https:", host: "director.mmadan.in" }, "abcdefghijk", 2)).toBe(
      "wss://director.mmadan.in/api/live?videoId=abcdefghijk&shot=2",
    );
    expect(liveUrl({ protocol: "http:", host: "localhost:3000" }, "abc", 0)).toBe(
      "ws://localhost:3000/api/live?videoId=abc&shot=0",
    );
  });

  it("says when Director is coming straight back, so it doesn't say hello again", () => {
    expect(liveUrl({ protocol: "http:", host: "localhost:3000" }, "abc", 1, true)).toBe(
      "ws://localhost:3000/api/live?videoId=abc&shot=1&resume=1",
    );
  });
});

describe("what Director live says", () => {
  const json = (value: unknown) => JSON.stringify(value);

  it("reads every message the relay sends", () => {
    expect(parseServerMessage(json({ type: "audio", pcm16: "AAAA" }))).toEqual({
      type: "audio",
      pcm16: "AAAA",
    });
    expect(parseServerMessage(json({ type: "transcript", who: "you", text: "hi" }))).toEqual({
      type: "transcript",
      who: "you",
      text: "hi",
    });
    const tool = { type: "tool", id: "tool-1", call: { name: "go_to_shot", shot: 1 } };
    expect(parseServerMessage(json(tool))).toEqual(tool);
    expect(parseServerMessage(json({ type: "interrupted" }))).toEqual({ type: "interrupted" });
    expect(parseServerMessage(json({ type: "error", code: "RATE_LIMITED" }))).toEqual({
      type: "error",
      code: "RATE_LIMITED",
    });
  });

  it("reads an error code it doesn't know as our own failure", () => {
    expect(parseServerMessage(json({ type: "error", code: "SOMETHING_NEW" }))).toEqual({
      type: "error",
      code: "INTERNAL",
    });
  });

  it("ignores what isn't one of them", () => {
    expect(parseServerMessage("not json")).toBeNull();
    const unknown = { type: "tool", id: "tool-1", call: { name: "start_recording" } };
    expect(parseServerMessage(json(unknown))).toBeNull();
    expect(parseServerMessage(json({ type: "audio", pcm16: "%%%" }))).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});

describe("the captions", () => {
  it("builds each side's line from the pieces transcribed as it's spoken", () => {
    let captions = withTranscript(NO_CAPTIONS, "director", "Hi! ");
    captions = withTranscript(captions, "director", "Step back a little.");
    expect(captions.director).toEqual({ text: "Hi! Step back a little.", key: 1 });
    expect(captions.you).toBeNull();
    captions = withTranscript(captions, "you", "Like");
    captions = withTranscript(captions, "you", " this?");
    expect(captions.you).toEqual({ text: "Like this?", key: 2 });
    // The director answering starts a new line, and the member's stays up.
    captions = withTranscript(captions, "director", "Perfect.");
    expect(captions.director).toEqual({ text: "Perfect.", key: 3 });
    expect(captions.you?.text).toBe("Like this?");
  });

  it("keeps a long line to its last words", () => {
    const words = Array.from({ length: 80 }, (_, at) => `word${at}`).join(" ");
    const { director } = withTranscript(NO_CAPTIONS, "director", words);
    expect(director?.text.length).toBeLessThanOrEqual(160);
    expect(director?.text.startsWith("…")).toBe(true);
    expect(director?.text.endsWith("word79")).toBe(true);
    // Cut between words, never through one.
    expect(director?.text).toMatch(/^…word\d+ /);
  });
});
