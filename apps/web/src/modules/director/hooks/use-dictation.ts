"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { canDictate, type Dictation, startDictation } from "../lib/dictation";

/**
 * Saying a message instead of typing it (lib/dictation, the browser's own recogniser):
 * each finished phrase goes to `onPhrase` while it listens, from a tap on the mic until
 * the next. `supported` is false where the browser has no recogniser or refused it (the
 * mic button isn't shown), and until the effect has looked.
 */
export function useDictation(onPhrase: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const latest = useRef(onPhrase);
  const dictation = useRef<Dictation | null>(null);
  useLayoutEffect(() => {
    latest.current = onPhrase;
  });
  useEffect(() => {
    setSupported(canDictate());
    return () => dictation.current?.stop();
  }, []);

  const stop = () => {
    dictation.current?.stop();
    dictation.current = null;
    setListening(false);
  };
  const start = () => {
    if (dictation.current) {
      return;
    }
    dictation.current = startDictation({
      onSaid: (text) => latest.current(text),
      onDeaf: () => {
        stop();
        setSupported(false);
      },
    });
    setListening(dictation.current !== null);
  };
  return { supported, listening, start, stop };
}
