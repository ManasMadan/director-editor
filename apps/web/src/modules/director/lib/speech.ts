/**
 * Director's voice: lines read out with the browser's own speech synthesis (Web Speech
 * API), in the page's language, in the warmest voice the device has. A line already said
 * is not said again until something else has been.
 *
 * The seam for a real-time voice (Gemini Live's native audio): `say` and `hush` are all
 * the camera screen calls, and `speaking`/`saying` all it reads. A streamed voice would
 * implement the same four over its audio player; nothing that calls them changes.
 */
function canSpeak() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Voices that sound like a person rather than a robot, best first, by name. */
const NATURAL = [/natural/i, /premium/i, /enhanced/i, /neural/i, /google/i, /siri/i, /samantha/i];

/** The voice to read `locale` in: the most natural of this device's voices for it. */
export function voiceFor<Voice extends Pick<SpeechSynthesisVoice, "lang" | "name">>(
  voices: readonly Voice[],
  locale: string,
): Voice | null {
  const language = locale.toLowerCase().replace(/-.*/, "");
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  const rank = (voice: Voice) => {
    const natural = NATURAL.findIndex((pattern) => pattern.test(voice.name));
    return natural === -1 ? NATURAL.length : natural;
  };
  return [...matching].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

let lastSaid = "";
let current: string | null = null;
const listeners = new Set<() => void>();

function setCurrent(line: string | null) {
  current = line;
  for (const listener of listeners) {
    listener();
  }
}

export function say(text: string, locale: string) {
  if (!canSpeak() || text === lastSaid) {
    return;
  }
  lastSaid = text;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  // None for the language: the browser's own default.
  utterance.voice = voiceFor(window.speechSynthesis.getVoices(), locale);
  // A touch quicker and brighter than the default: an upbeat director, not a narrator.
  utterance.rate = 1.06;
  utterance.pitch = 1.05;
  utterance.onstart = () => setCurrent(text);
  utterance.onend = () => setCurrent(current === text ? null : current);
  utterance.onerror = () => setCurrent(null);
  window.speechSynthesis.speak(utterance);
}

/** Stops whatever Director is saying: the member interrupted, or a take is starting. */
export function hush() {
  lastSaid = "";
  if (canSpeak()) {
    window.speechSynthesis.cancel();
  }
  setCurrent(null);
}

/** What Director is saying right now, or null (for React's useSyncExternalStore). */
export const saying = () => current;

export function onSaying(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
