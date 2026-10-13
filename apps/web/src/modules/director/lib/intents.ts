/**
 * Talking to Director: what a spoken phrase asks for, and whether it was the member at
 * all. The words for each request come from the member's language (the `voice.words`
 * messages in packages/i18n), so a new locale brings its own; the longest phrase that
 * matches wins, so "go again" is a retake and not "go".
 *
 * The microphone also hears Director's own voice from the speaker. A phrase that is
 * mostly words Director is saying right now is its echo, not the member: it neither
 * interrupts Director nor counts as a request.
 */

const INTENTS = [
  "action",
  "cut",
  "again",
  "keep",
  "flip",
  "repeat",
  "help",
  "quiet",
  "talk",
] as const;
export type Intent = (typeof INTENTS)[number];

/** For each request, its phrases separated by `|`: "action|record|let's go". */
export type Vocabulary = Record<Intent, string>;

/** Lower case, no accents or punctuation, single spaces: "¡Acción!" → "accion". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The request a phrase makes, or null when it makes none. */
export function intentOf(heard: string, vocabulary: Vocabulary): Intent | null {
  const padded = ` ${normalize(heard)} `;
  let best: { intent: Intent; length: number } | null = null;
  for (const intent of INTENTS) {
    for (const phrase of vocabulary[intent].split("|").map(normalize)) {
      if (phrase && padded.includes(` ${phrase} `) && phrase.length > (best?.length ?? 0)) {
        best = { intent, length: phrase.length };
      }
    }
  }
  return best?.intent ?? null;
}

/** At least this share of the words heard are in what Director is saying: its echo. */
const ECHO_SHARE = 0.6;

export function isEcho(heard: string, saying: string | null): boolean {
  if (!saying) {
    return false;
  }
  const words = normalize(heard).split(" ").filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const said = new Set(normalize(saying).split(" "));
  return words.filter((word) => said.has(word)).length / words.length >= ECHO_SHARE;
}

/** Recognisers report 0 when they don't know; below this, a known guess is noise. */
const LEAST_CONFIDENCE = 0.35;

/** Whether a phrase is worth acting on: some words, and not a guess the recogniser doubts. */
export function isClear(heard: string, confidence: number): boolean {
  return normalize(heard).length >= 2 && (confidence === 0 || confidence >= LEAST_CONFIDENCE);
}
