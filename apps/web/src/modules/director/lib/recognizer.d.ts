/**
 * The Web Speech API's recogniser, which TypeScript's DOM library types the events of but
 * not the class itself: Chrome and Safari have it (Safari as `webkitSpeechRecognition`),
 * Firefox doesn't, so both are optional.
 */
interface Recognizer extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface Window {
  SpeechRecognition?: new () => Recognizer;
  webkitSpeechRecognition?: new () => Recognizer;
}
