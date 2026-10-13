/**
 * Director's voice: instructions read out with the browser's own speech synthesis
 * (Web Speech API), in the page's language. A line already said is not said again until
 * something else has been.
 */
function canSpeak() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let lastSaid = "";

export function say(text: string, locale: string, { interrupt = true } = {}) {
  if (!canSpeak() || text === lastSaid) {
    return;
  }
  lastSaid = text;
  if (interrupt) {
    window.speechSynthesis.cancel();
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

export function hush() {
  lastSaid = "";
  if (canSpeak()) {
    window.speechSynthesis.cancel();
  }
}
