"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const recognizerClass = () => window.SpeechRecognition ?? window.webkitSpeechRecognition;

/**
 * Saying a message instead of typing it, with the browser's own recogniser, in the
 * member's language: each finished phrase goes to `onPhrase`, and listening stops by
 * itself after a pause, as dictation does. `supported` is false where the browser has no
 * recogniser (the mic button isn't shown) and until the effect has looked.
 */
export function useDictation(locale: string, onPhrase: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const latest = useRef(onPhrase);
  const recognizer = useRef<Recognizer | null>(null);
  useLayoutEffect(() => {
    latest.current = onPhrase;
  });
  useEffect(() => {
    setSupported(recognizerClass() !== undefined);
    return () => recognizer.current?.abort();
  }, []);

  const start = () => {
    const Recognition = recognizerClass();
    if (!Recognition || recognizer.current) {
      return;
    }
    const next = new Recognition();
    next.lang = locale;
    next.continuous = false;
    next.interimResults = false;
    next.onresult = (event) => {
      for (const result of Array.from(event.results).slice(event.resultIndex)) {
        const text = result.item(0).transcript.trim();
        if (result.isFinal && text) {
          latest.current(text);
        }
      }
    };
    next.onend = () => {
      recognizer.current = null;
      setListening(false);
    };
    recognizer.current = next;
    next.start();
    setListening(true);
  };
  const stop = () => recognizer.current?.stop();
  return { supported, listening, start, stop };
}
