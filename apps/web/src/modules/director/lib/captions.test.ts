import { describe, expect, it } from "vitest";
import { captionAt, webVtt, wrapWords } from "./captions";

describe("captions", () => {
  it("writes a script as WebVTT cues", () => {
    expect(
      webVtt([
        { startSeconds: 0, endSeconds: 2.5, text: "First, the top." },
        { startSeconds: 3661, endSeconds: 3662, text: "a --> b" },
      ]),
    ).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nFirst, the top.\n\n01:01:01.000 --> 01:01:02.000\na -> b",
    );
    expect(webVtt([])).toBe("WEBVTT");
  });

  it("lights the word being said, timed by its share of the line's letters", () => {
    const lines = [{ startSeconds: 1, endSeconds: 3, text: "hi  everyone" }];
    const states = (seconds: number) => captionAt(lines, seconds)?.map((word) => word.state);
    expect(captionAt(lines, 0.5)).toBeNull();
    expect(captionAt(lines, 1)?.map((word) => word.text)).toEqual(["hi", "everyone"]);
    expect(states(1)).toEqual(["now", "next"]);
    // "hi" is 2 of 10 letters: its fifth of the two seconds is over at 1.4 s.
    expect(states(1.5)).toEqual(["said", "now"]);
    expect(states(2.99)).toEqual(["said", "now"]);
    expect(captionAt(lines, 3)).toBeNull();
    expect(captionAt([{ startSeconds: 0, endSeconds: 1, text: "  " }], 0.5)).toBeNull();
  });

  it("wraps words into rows that fit, a long word on its own", () => {
    const words = ["one", "two", "three", "extraordinarily", "go"].map((text) => ({ text }));
    const rows = wrapWords(words, (text) => text.length, 9);
    expect(rows.map((row) => row.map((word) => word.text).join(" "))).toEqual([
      "one two",
      "three",
      "extraordinarily",
      "go",
    ]);
    expect(wrapWords([], (text) => text.length, 9)).toEqual([]);
  });
});
