/**
 * Director's voice. A line is said in Director's own voice when the camera screen has one
 * (`Voice`: Gemini's text-to-speech, a link to the line spoken, from
 * hooks/use-director-voice.ts), and otherwise, or when that voice fails or keeps the
 * member waiting, read out with the browser's own speech synthesis (Web Speech API), in
 * the page's language, in the warmest voice the device has. A line already said is not
 * said again until something else has been. On a live call none of this speaks: Gemini
 * Live does the talking.
 *
 * `say` and `hush` are all the camera screen calls, and `speaking`/`saying` all it reads.
 */
import { SECOND_MS } from "@repo/contracts/time";

/** A line in Director's own voice: a link to play it from; rejects when there's none. */
export type Voice = (text: string) => Promise<string>;

/**
 * How long a line may take to come in Director's own voice before the browser's says it
 * instead: the first time a line is spoken takes Gemini a second or two, and a cue that
 * arrives late is worse than one in a plainer voice.
 */
const VOICE_WAIT_MS = 2 * SECOND_MS;

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
/** Bumped by every new line and by `hush`: a line still on its way checks it's still its turn. */
let turn = 0;
/** The line playing in Director's own voice, if one is. */
let playing: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();

function setCurrent(line: string | null) {
  current = line;
  for (const listener of listeners) {
    listener();
  }
}

/** Stops whatever is being said, in either voice, and whatever is still on its way. */
function silence() {
  turn += 1;
  if (playing) {
    playing.pause();
    playing = null;
    setCurrent(null);
  }
  if (canSpeak()) {
    window.speechSynthesis.cancel();
  }
}

/** Reads a line out in the browser's own voice. */
function sayAloud(text: string, locale: string) {
  if (!canSpeak()) {
    return;
  }
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

/** Plays a line from its link; `failed` when the browser can't (or won't) play it. */
function play(url: string, text: string, failed: () => void) {
  const audio = new Audio(url);
  playing = audio;
  let started = false;
  // Doesn't fire once `silence` has paused it: a line cut off says nothing more.
  audio.onplaying = () => {
    started = true;
    setCurrent(text);
  };
  // The line is over: it ended, its sound broke off (an error, or its loading cut short),
  // or the browser couldn't or wouldn't play it. One that never started is said in the
  // browser's voice instead. A line no longer playing (another came, or Director went
  // quiet) has nothing to make up for, and leaves what's said now alone.
  const over = () => {
    if (playing !== audio) {
      return;
    }
    playing = null;
    setCurrent(null);
    if (!started) {
      failed();
    }
  };
  audio.onended = over;
  audio.onerror = over;
  audio.onabort = over;
  audio.play().catch(over);
}

/**
 * A line in Director's own voice, or in the browser's when that can't be had in time:
 * whichever comes first says it, once, and only while it's still this line's turn.
 */
function sayInVoice(text: string, locale: string, voice: Voice) {
  const mine = turn;
  let claimed = false;
  const claim = () => {
    const free = !claimed && mine === turn;
    claimed = true;
    return free;
  };
  const aloud = () => sayAloud(text, locale);
  const timer = window.setTimeout(() => claim() && aloud(), VOICE_WAIT_MS);
  voice(text).then(
    (url) => {
      window.clearTimeout(timer);
      if (claim()) {
        play(url, text, aloud);
      }
    },
    () => {
      window.clearTimeout(timer);
      if (claim()) {
        aloud();
      }
    },
  );
}

export function say(text: string, locale: string, voice?: Voice) {
  if (text === lastSaid) {
    return;
  }
  lastSaid = text;
  silence();
  if (voice) {
    sayInVoice(text, locale, voice);
  } else {
    sayAloud(text, locale);
  }
}

/** Stops whatever Director is saying: the member interrupted, or a take is starting. */
export function hush() {
  lastSaid = "";
  silence();
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
