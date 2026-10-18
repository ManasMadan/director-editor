/**
 * The member's voice on Director's slower line: the browser's own speech recogniser
 * (the Web Speech API), used as dictation only. Each finished phrase is a turn, as if
 * typed; nothing is listened for as a command. It's paused while Director speaks (its
 * own voice from the speaker would come back as words) and while a take records.
 *
 * Browsers stop recognising after a pause or a while; it's started again for as long as
 * it's wanted. Where there's no recogniser (Firefox) or it's refused, the member types.
 */

/** The part of the Web Speech API's SpeechRecognition this uses (TypeScript's DOM lib lacks it). */
interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  start(): void;
  stop(): void;
}

type RecognizerClass = new () => Recognizer;

declare global {
  interface Window {
    SpeechRecognition?: RecognizerClass;
    webkitSpeechRecognition?: RecognizerClass;
  }
}

/** Refusals that won't pass by trying again: the member types instead. */
const REFUSED: readonly SpeechRecognitionErrorCode[] = [
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "language-not-supported",
];

export interface Dictation {
  /** Stops listening for now (Director speaking, a take recording), or starts again. */
  pause(on: boolean): void;
  stop(): void;
}

/** The browser's recogniser, or null where it has none. */
function recognizerClass(): RecognizerClass | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Starts dictation: `onSaid` gets each finished phrase, `onDeaf` once when it can't
 * listen at all (no recogniser, or refused). Null when it can't start.
 */
export function startDictation(events: {
  onSaid: (text: string) => void;
  onDeaf: () => void;
}): Dictation | null {
  const Recognition = recognizerClass();
  if (!Recognition) {
    events.onDeaf();
    return null;
  }
  const recognizer = new Recognition();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = navigator.language;
  let paused = false;
  let over = false;
  let running = false;
  const run = () => {
    if (over || paused || running) {
      return;
    }
    try {
      recognizer.start();
      running = true;
    } catch {
      // Already starting (a quick pause and resume): its own end starts it again.
      return;
    }
  };
  recognizer.onresult = (event) => {
    for (let at = event.resultIndex; at < event.results.length; at += 1) {
      const result = event.results[at];
      const text = result?.isFinal ? result[0]?.transcript.trim() : "";
      if (text && !paused) {
        events.onSaid(text);
      }
    }
  };
  recognizer.onerror = (event) => {
    if (REFUSED.includes(event.error)) {
      over = true;
      events.onDeaf();
    }
  };
  recognizer.onend = () => {
    running = false;
    run();
  };
  run();
  return {
    pause(on) {
      paused = on;
      if (on) {
        recognizer.stop();
      } else {
        run();
      }
    },
    stop() {
      over = true;
      recognizer.onend = null;
      recognizer.stop();
    },
  };
}
