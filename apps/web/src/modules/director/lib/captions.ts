/**
 * Captions, from a script's timed lines: WebVTT for a video's caption track, and the
 * styled captions drawn over the preview and burned into the finished short (one word
 * lit as it is said, the way short-form captions read).
 */
import type { Shot } from "@repo/contracts/api";
import { HOUR_S, MINUTE_S } from "@repo/contracts/time";

export type CaptionLine = Shot["script"][number];

/** "pop": big words, the one being said on a red tag; "classic": YouTube's boxed CC. */
export const captionStyles = ["pop", "classic", "off"] as const;
export type CaptionStyle = (typeof captionStyles)[number];

export interface CaptionWord {
  text: string;
  state: "said" | "now" | "next";
}

function timestamp(seconds: number) {
  const whole = Math.max(0, seconds);
  const hours = Math.floor(whole / HOUR_S);
  const minutes = Math.floor((whole % HOUR_S) / MINUTE_S);
  const rest = (whole % MINUTE_S).toFixed(3).padStart(6, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${rest}`;
}

export function webVtt(script: readonly CaptionLine[]): string {
  const cues = script.map(
    (line) =>
      `${timestamp(line.startSeconds)} --> ${timestamp(line.endSeconds)}\n${line.text.replaceAll("-->", "->")}`,
  );
  return ["WEBVTT", ...cues].join("\n\n");
}

/**
 * The line on screen at `seconds`, word by word: each word's share of the line's time is
 * its share of the letters, so a long word stays lit longer. Null between lines.
 */
export function captionAt(lines: readonly CaptionLine[], seconds: number): CaptionWord[] | null {
  const line = lines.find((each) => seconds >= each.startSeconds && seconds < each.endSeconds);
  const words = line?.text.split(/\s+/).filter(Boolean) ?? [];
  if (!line || words.length === 0) {
    return null;
  }
  const letters = words.reduce((sum, word) => sum + word.length, 0);
  const reached = ((seconds - line.startSeconds) / (line.endSeconds - line.startSeconds)) * letters;
  let passed = 0;
  return words.map((text) => {
    const start = passed;
    passed += text.length;
    if (reached >= passed) {
      return { text, state: "said" };
    }
    return { text, state: reached >= start ? "now" : "next" };
  });
}

/** Words into rows no wider than `maxWidth`, as `measure` sizes them (a long word gets a row). */
export function wrapWords<T extends { text: string }>(
  words: readonly T[],
  measure: (text: string) => number,
  maxWidth: number,
): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  for (const word of words) {
    const candidate = [...row, word].map((each) => each.text).join(" ");
    if (row.length > 0 && measure(candidate) > maxWidth) {
      rows.push(row);
      row = [word];
    } else {
      row.push(word);
    }
  }
  if (row.length > 0) {
    rows.push(row);
  }
  return rows;
}
