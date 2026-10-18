import { describe, expect, it } from "vitest";
import {
  answered,
  type Captions,
  liveUrl,
  NO_CAPTIONS,
  parseServerMessage,
  turnEnded,
  withoutMember,
  withTranscript,
  withTyped,
} from "./live";

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
  const texts = (captions: Captions) => captions.lines.map(({ who, text }) => `${who}: ${text}`);

  it("reads in order: each line under the one it answers, the last exchange only", () => {
    let captions = withTranscript(NO_CAPTIONS, "director", "Hi! ");
    captions = withTranscript(captions, "director", "How long have you got?");
    expect(captions.lines).toEqual([
      { who: "director", text: "Hi! How long have you got?", key: 1, done: false },
    ]);
    captions = withTranscript(captions, "you", "Like");
    captions = withTranscript(captions, "you", " ten minutes");
    // The member's answer goes under Director's question, which is finished now.
    expect(texts(captions)).toEqual([
      "director: Hi! How long have you got?",
      "you: Like ten minutes",
    ]);
    expect(captions.lines.map((line) => line.done)).toEqual([true, false]);
    captions = withTranscript(captions, "director", "Plenty.");
    // Director's reply sits under the line it answers; the first line has gone.
    expect(texts(captions)).toEqual(["you: Like ten minutes", "director: Plenty."]);
    expect(answered(captions)).toBe(false);
    captions = turnEnded(captions);
    expect(answered(captions)).toBe(true);
    // Its next turn is a new line.
    captions = withTranscript(captions, "director", "Prop the phone up.");
    expect(texts(captions)).toEqual(["director: Plenty.", "director: Prop the phone up."]);
    expect(answered(captions)).toBe(false);
  });

  it("puts a typed line under the rest, finished, and drops the member's line when asked", () => {
    let captions = withTranscript(NO_CAPTIONS, "director", "Ready?");
    captions = withTyped(captions, "yes");
    expect(texts(captions)).toEqual(["director: Ready?", "you: yes"]);
    expect(captions.lines.at(-1)?.done).toBe(true);
    // A typed line right after another is its own line too.
    captions = withTyped(captions, "go");
    expect(texts(captions)).toEqual(["you: yes", "you: go"]);
    expect(texts(withoutMember(captions))).toEqual([]);
    const directorOnly = withTranscript(NO_CAPTIONS, "director", "Hi.");
    expect(withoutMember(directorOnly)).toBe(directorOnly);
  });

  it("keeps a long line to its last words", () => {
    const words = Array.from({ length: 80 }, (_, at) => `word${at}`).join(" ");
    const director = withTranscript(NO_CAPTIONS, "director", words).lines[0];
    expect(director?.text.length).toBeLessThanOrEqual(160);
    expect(director?.text.startsWith("…")).toBe(true);
    expect(director?.text.endsWith("word79")).toBe(true);
    // Cut between words, never through one.
    expect(director?.text).toMatch(/^…word\d+ /);
  });
});
