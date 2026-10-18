import { describe, expect, it } from "vitest";
import { type JsonLine, jsonLines } from "./plan-json";

const text = (lines: JsonLine[]) => lines.map((line) => line.tokens.map((t) => t.text).join(""));

describe("jsonLines", () => {
  it("keeps what fits on one line together and opens up what doesn't", () => {
    const shot = {
      title: "Intro",
      framing: { shotSize: "medium", subject: { x: 0.12, y: 0.15 } },
      script: [{ text: "A line long enough not to fit beside anything else" }, { text: "Hi" }],
      tags: [],
      notes: {},
      flags: [true, null],
    };
    expect(text(jsonLines(shot, 40))).toEqual([
      "{",
      '  "title": "Intro",',
      '  "framing": {',
      '    "shotSize": "medium",',
      '    "subject": { "x": 0.12, "y": 0.15 }',
      "  },",
      '  "script": [',
      "    {",
      '      "text": "A line long enough not to fit beside anything else"',
      "    },",
      '    { "text": "Hi" }',
      "  ],",
      '  "tags": [],',
      '  "notes": {},',
      '  "flags": [true, null]',
      "}",
    ]);
  });

  it("says which of the shot's fields each line shows, and what each token is", () => {
    const lines = jsonLines({ size: "wide", seconds: 2.5 }, 40);
    expect(lines.map((line) => line.field)).toEqual([null, "size", "seconds", null]);
    expect(lines.map((line) => line.number)).toEqual([1, 2, 3, 4]);
    expect(lines[1]?.tokens).toEqual([
      { kind: "space", text: "  " },
      { kind: "key", text: '"size"' },
      { kind: "punctuation", text: ": " },
      { kind: "string", text: '"wide"' },
      { kind: "punctuation", text: "," },
    ]);
    expect(lines[2]?.tokens).toContainEqual({ kind: "number", text: "2.5" });
  });
});
