/**
 * A shot's purpose as the member reads it. Gemini writes it as "hook: introduce the
 * observation, curious and friendly": the beat's name, a colon, then the words. The beat
 * is the plan's own vocabulary, not the member's, so it's dropped and the rest starts
 * with a capital, as the page's other copy does.
 */
// One lower-case word (or two joined by a hyphen) before the colon: a beat, not a sentence.
const BEAT_PREFIX = /^\s*[a-z]+(?:-[a-z]+)?:\s+/;

export function plainPurpose(purpose: string): string {
  const words = purpose.replace(BEAT_PREFIX, "").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
